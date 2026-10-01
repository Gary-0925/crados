// IndexedDB 持久化层的验收脚本。
//
//   npm run persist
//
// 浏览器里才有真的 IndexedDB，Node 里没有，所以这里先装一个最小内存版
// （只实现分块存档用到的那几个面），再驱动真实的 src/hw/store.ts 与内核：
//
//   1. 整盘存取：写进去的字节要原样读回来，shadow 对齐
//   2. 增量回写：改一个字节只落一个 16 KiB 分块，不是整盘重写
//   3. 存档登记与撤档：listStoredDisks / dropDev
//   4. 启动介质：空盘落档 → 存档原样恢复（连 /tmp 里的文件都在）→ 可移动盘装回；
//      固件探测只列介质，不解析盘上的文件系统
//
// 由 scripts/persist-check.mjs 打包后运行。

import { probeBootMedia } from '@/hw/boot'
import { BlockDev, SPECS } from '@/hw/disk'
import { dropDev, listStoredDisks, loadDev, persistAvailable, saveDev } from '@/hw/store'
import { Kernel } from '@/os/kernel'
import { T_FILE } from '@/os/fs'

// ---------- 最小内存版 IndexedDB ----------
//
// 语义照真实实现来：请求在事务内同步结算，oncomplete 之后才到；
// 数据存在进程级的 map 里，跨多次 open 都在——就像浏览器里跨重启都在。

const stats = { chunkPuts: 0, mediaPuts: 0 }
let tables: Map<string, Map<string, unknown>> | null = null

type Handler = (() => void) | null

class Request<T> {
  result: T | undefined
  error: Error | null = null
  onsuccess: Handler = null
  onerror: Handler = null
  constructor(private readonly work: () => T) {}
  fire() {
    try {
      this.result = this.work()
    } catch (e) {
      this.error = e as Error
      this.onerror?.()
      return
    }
    this.onsuccess?.()
  }
}

class ObjectStore {
  constructor(
    private readonly name: string,
    private readonly data: Map<string, unknown>,
    private readonly tx: Transaction,
  ) {}
  put(value: unknown, key?: IDBValidKey) {
    if (this.name === 'chunks') stats.chunkPuts++
    else stats.mediaPuts++
    const at = String(key)
    return this.tx.issue(() => {
      this.data.set(at, value)
    })
  }
  get(key: IDBValidKey) {
    const at = String(key)
    return this.tx.issue(() => this.data.get(at))
  }
  getAll() {
    return this.tx.issue(() => [...this.data.values()])
  }
  delete(key: IDBValidKey) {
    const at = String(key)
    return this.tx.issue(() => {
      this.data.delete(at)
    })
  }
}

// 请求像真 IDB 一样异步结算：先发出去，下一个微任务才回来；
// 事务在所有请求都回来之后才 oncomplete——回调里还能继续发请求。
class Transaction {
  oncomplete: Handler = null
  onerror: Handler = null
  onabort: Handler = null
  private readonly stores: ObjectStore[]
  private pending = 0
  private finished = false
  constructor(
    private readonly tables: Map<string, Map<string, unknown>>,
    names: string[],
  ) {
    this.stores = names.map((n) => new ObjectStore(n, this.tables.get(n)!, this))
    queueMicrotask(() => this.finishIfIdle())
  }
  issue<T>(work: () => T): Request<T> {
    const request = new Request(work)
    this.pending++
    queueMicrotask(() => {
      request.fire()
      this.pending--
      this.finishIfIdle()
    })
    return request
  }
  private finishIfIdle() {
    if (this.pending === 0 && !this.finished) {
      this.finished = true
      this.oncomplete?.()
    }
  }
  objectStore(name: string): ObjectStore {
    const store = this.stores.find((s) => s['name'] === name)
    if (!store) throw new Error(`no such object store: ${name}`)
    return store
  }
  abort() {
    this.onabort?.()
  }
}

class Database {
  readonly objectStoreNames = { contains: (name: string) => this.tables.has(name) }
  constructor(private readonly tables: Map<string, Map<string, unknown>>) {}
  transaction(names: string | string[], mode: IDBTransactionMode) {
    void mode
    return new Transaction(this.tables, typeof names === 'string' ? [names] : names)
  }
  createObjectStore(name: string) {
    const data = new Map<string, unknown>()
    this.tables.set(name, data)
    return new ObjectStore(name, data, null as unknown as Transaction)
  }
  close() {}
}

const mockIndexedDB = {
  open() {
    const request: {
      result: Database | null
      error: Error | null
      onupgradeneeded: Handler
      onsuccess: Handler
      onerror: Handler
      onblocked: Handler
    } = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
    setTimeout(() => {
      const fresh = tables === null
      if (fresh) tables = new Map()
      request.result = new Database(tables!)
      if (fresh) request.onupgradeneeded?.()
      request.onsuccess?.()
    }, 0)
    return request
  },
}

;(globalThis as { indexedDB?: IDBFactory }).indexedDB = mockIndexedDB as unknown as IDBFactory

// ---------- 断言 ----------

const failures: string[] = []
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

async function main() {
  check('内存版 IndexedDB 已就位', persistAvailable())

  // ---------- 1. 整盘存取 ----------
  const dev = new BlockDev(SPECS.sda)
  const pattern = new Uint8Array(dev.size)
  for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 7 + (i >> 9)) & 0xff
  dev.load(pattern)

  check('整盘落盘', (await saveDev(dev)) === true)
  check('落盘之后 shadow 与内容对齐', same(dev.bytes, dev.shadow))

  const back = new BlockDev(SPECS.sda)
  check('整盘读回', (await loadDev(back)) === true)
  check('读回的字节与写入一致', same(back.bytes, pattern))

  // ---------- 2. 增量回写 ----------
  stats.chunkPuts = 0
  back.bytes[5] = back.bytes[5]! ^ 0xff
  check('增量落盘', (await saveDev(back)) === true)
  check('改一个字节只写一个 16 KiB 分块', stats.chunkPuts === 1, `${stats.chunkPuts} 个分块`)

  const again = new BlockDev(SPECS.sda)
  check('增量之后仍能整盘读回', (await loadDev(again)) === true)
  check('读回的是改动后的内容', again.bytes[5] === (pattern[5]! ^ 0xff))

  stats.chunkPuts = 0
  await saveDev(again)
  check('没有改动时一个分块都不写', stats.chunkPuts === 0, `${stats.chunkPuts} 个分块`)

  // ---------- 3. 存档登记与撤档 ----------
  const media = await listStoredDisks()
  check(
    '登记了 sda 的分块数、字节数与时间',
    media.length === 1 && media[0]!.name === 'sda' && media[0]!.chunks === 64 && media[0]!.bytes === dev.size,
    `${media.length} 条记录，${media[0]?.stored.length ?? 0} 个分块`,
  )

  // ---------- 3b. 稀疏盘：全零分块存得下、读得回 ----------
  // 历史疑点：localStorage 时代存的时候跳过全零分块，读的时候却要求每个分块都在，
  // 结果整盘读不回来。出厂根盘大量分块就是零，所以那个做法永远加载不了存档。
  await dropDev('sda')
  stats.chunkPuts = 0
  const sparse = new BlockDev(SPECS.sda)
  sparse.bytes.set([0x53, 0xef, 1, 2, 3], 1080) // 贴点数据在第一个分块里
  sparse.bytes.set([0x7f, 0x43, 0x52, 0x58], 63 * 16 * 1024) // 再放一点在最后一个分块
  check('稀疏盘落盘', (await saveDev(sparse)) === true)
  check('空分块不写，只写有内容的', stats.chunkPuts === 2, `${stats.chunkPuts} 个分块`)
  const sparseBack = new BlockDev(SPECS.sda)
  check('空分块按零读回', (await loadDev(sparseBack)) === true)
  check('稀疏盘字节一致', same(sparseBack.bytes, sparse.bytes))
  const sparseMedia = (await listStoredDisks())[0]
  check(
    '登记的分块清单只有有内容的那些',
    sparseMedia?.stored.join(',') === '0,63',
    sparseMedia?.stored.join(','),
  )
  await dropDev('sda')
  check('撤档之后读不到', (await loadDev(new BlockDev(SPECS.sda))) === false)
  check('撤档之后登记为空', (await listStoredDisks()).length === 0)

  // ---------- 4. 启动介质 ----------
  check('新机器上电前系统盘位是空的', new Kernel().machine.disks.system === null)
  const fresh = new Kernel()
  check('创建空盘并装载系统', (await fresh.machine.powerOn({ kind: 'blank' })) === null && fresh.panic === null, fresh.panic ?? '')
  const passwordScreen = () => fresh.machine.console.screen().map((line) => line.segs.map((segment) => segment.t).join('')).join('\n')
  const passwordFingerprint = () => {
    const lines = fresh.machine.console.screen()
    return `${lines.length}|${lines.slice(-2).map((line) => line.segs.map((segment) => segment.t).join('')).join('\u0001')}`
  }
  const settlePassword = (quietTicks = 30, quietMs = 300, max = 40000) => {
    let quiet = 0
    let last = passwordFingerprint()
    let lastChange = performance.now()
    for (let i = 0; i < max; i++) {
      fresh.step()
      const next = passwordFingerprint()
      if (next !== last) {
        last = next
        quiet = 0
        lastChange = performance.now()
      } else if (++quiet > quietTicks && performance.now() - lastChange > quietMs) return true
    }
    return false
  }
  const typePasswordLine = (text: string) => {
    for (const character of text) fresh.typeChar(character)
    fresh.pressEnter()
  }
  const rootPassword = 'persisted-root-passphrase-2026'
  settlePassword()
  typePasswordLine('root')
  settlePassword()
  check('新盘要求设置 root 密码', /Set an initial password for root/.test(passwordScreen()))
  typePasswordLine(rootPassword)
  settlePassword()
  typePasswordLine(rootPassword)
  settlePassword()
  typePasswordLine('root')
  settlePassword()
  typePasswordLine(rootPassword)
  settlePassword()
  check('持久化测试账户已通过密码登录', /root@crados:\/root\$/.test(passwordScreen()))
  const fs = fresh.filesystem('sda')!
  const etcIno = fs.lookup(2, 'etc')
  const passwdIno = etcIno ? fs.lookup(etcIno, 'passwd') : 0
  const passwdText = passwdIno ? fs.read(passwdIno) : ''
  check('密码更新写入 root-only bcrypt 账户文件', /^root:0:\$2b\$12\$[./A-Za-z0-9]{53}:lmbka$/m.test(passwdText) && fs.iflags(passwdIno) === 0o600)

  // 在系统盘上留一个只有这台机器有的痕迹
  const tmp = fresh.vfs.resolve('/tmp', '/')
  if ('err' in tmp) check('/tmp 可解析', false, tmp.err)
  else {
    const ino = fs.create(tmp.ino, 'marker', T_FILE)
    if (typeof ino !== 'number') check('/tmp/marker 可创建', false, ino.err)
    else {
      fs.write(ino, 'persisted across boots')
      check('立刻回写系统盘', (await fresh.machine.disks.save('sda')) === true)
    }
  }

  const attached = await fresh.attachDisk('data')
  check('新建可移动空盘', attached === 0, JSON.stringify(attached))
  const names = (await listStoredDisks()).map((m) => m.name).sort()
  check('系统盘与新盘都落了档', names.join(',') === 'sda,sdb', names.join(','))

  // 固件探测：上电菜单要的信息全在介质这一层
  const probe = await probeBootMedia()
  check('固件探测能落盘', probe.storageOk)
  check('固件探测到系统盘存档', probe.system?.name === 'sda', JSON.stringify(probe.system?.name))
  check('固件探测把移动盘单列', probe.removable.map((m) => m.name).join(',') === 'sdb')
  check('上电后盘位记着介质', fresh.machine.disks.bootMedium?.kind === 'blank')

  await fresh.destroy()

  const stored = new Kernel()
  check('从 IndexedDB 加载', (await stored.machine.powerOn({ kind: 'stored' })) === null && stored.panic === null, stored.panic ?? '')
  const marker = stored.vfs.resolve('/tmp/marker', '/')
  const restoredFs = stored.filesystem('sda')!
  check(
    '恢复出来的盘带着上次写的文件',
    !('err' in marker) && restoredFs.read(marker.ino) === 'persisted across boots',
  )
  const restoredEtc = restoredFs.lookup(2, 'etc')
  const restoredPasswd = restoredEtc ? restoredFs.lookup(restoredEtc, 'passwd') : 0
  check(
    '重启后仍保留 bcrypt 凭据与文件权限',
    !!restoredPasswd && /^root:0:\$2b\$12\$[./A-Za-z0-9]{53}:lmbka$/m.test(restoredFs.read(restoredPasswd)) && restoredFs.iflags(restoredPasswd) === 0o600,
  )
  check('可移动盘被一并装回', stored.blockDevices().some((d) => d.name === 'sdb'))
  check(
    '系统程序照样重烧',
    stored.machine.console
      .screen()
      .some((l) => l.segs.some((s) => /bin: \d+ programs installed/.test(s.t))),
  )

  const image = stored.machine.disks.image('sda')!
  const fromImage = new Kernel()
  check(
    '从 .img 文件加载',
    (await fromImage.machine.powerOn({ kind: 'image', bytes: image, filename: 'sda.img' })) === null && fromImage.panic === null,
    fromImage.panic ?? '',
  )
  const marker2 = fromImage.vfs.resolve('/tmp/marker', '/')
  const imageFs = fromImage.filesystem('sda')!
  check('.img 里的文件也在', !('err' in marker2) && imageFs.read(marker2.ino) === 'persisted across boots')
  const imageEtc = imageFs.lookup(2, 'etc')
  const imagePasswd = imageEtc ? imageFs.lookup(imageEtc, 'passwd') : 0
  check('.img 保留 bcrypt 凭据', !!imagePasswd && /^root:0:\$2b\$12\$[./A-Za-z0-9]{53}:lmbka$/m.test(imageFs.read(imagePasswd)) && imageFs.iflags(imagePasswd) === 0o600)
  await fromImage.destroy()

  check('分离设备会撤档', (await stored.detachDisk('sdb')) === 0)
  check('撤档后不再登记 sdb', !(await listStoredDisks()).some((m) => m.name === 'sdb'))
  await stored.destroy()

  // ---------- 5. 启动失败不得废掉存档 ----------
  // 用户选了 .img 却是坏镜像：只好回到菜单换一个选项。
  // 这台没起来的机器一定不能落盘，否则它那份坏字节会把好好存着的旧盘覆盖掉。
  const doomed = new Kernel()
  const doomedErr = await doomed.machine.powerOn({ kind: 'image', bytes: new Uint8Array(1024 * 1024), filename: 'blank.img' })
  check('坏镜像启动失败', typeof doomedErr === 'string')
  await doomed.destroy()
  const survivor = new Kernel()
  check(
    '存档没被失败的启动污染',
    (await survivor.machine.powerOn({ kind: 'stored' })) === null && survivor.panic === null,
  )
  const marker3 = survivor.vfs.resolve('/tmp/marker', '/')
  check(
    '旧盘里的文件依然在',
    !('err' in marker3) && survivor.filesystem('sda')!.read(marker3.ino) === 'persisted across boots',
  )
  await survivor.destroy()
}

await main()

if (failures.length) {
  console.error(`\n${failures.length} 项失败:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nIndexedDB 持久化层验收通过')
