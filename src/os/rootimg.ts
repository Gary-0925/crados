// Builds the initial sda byte image from a declarative file table.

import { BlockDev, SPECS } from './blockdev'
import { applySystemPolicy, basename, CRFS, dirname, DRV_NULL, DRV_TTY, MODE_DIR, T_DEV, T_DIR, T_FILE, UID_ROOT } from './fs'
import { serializePasswd, factoryAccounts } from './accounts'
import { MAN_FILES } from '../man'
import {
  COUNT_S,
  BLOCK_S,
  HELLO_S,
  PAGE_S,
} from './rootfs'

const LABEL = 'crados-root'

// 出厂目录树。账户系统默认只有 root，密码为空；/home 留给 useradd。
const DIRS = ['/bin', '/dev', '/etc', '/usr', '/usr/bin', '/usr/man', '/mnt', '/tmp', '/home', '/root']

const FILES: [string, string][] = [
  ...MAN_FILES,
  ['/etc/passwd', serializePasswd(factoryAccounts())],
  ['/root/hello.s', HELLO_S],
  ['/root/count.s', COUNT_S],
  ['/root/page.s', PAGE_S],
  ['/root/block.s', BLOCK_S],
]

const DEVICES: [string, number][] = [
  ['/dev/tty', DRV_TTY],
  ['/dev/null', DRV_NULL],
]

export interface RootImage {
  bytes: Uint8Array
  errors: string[]
}

export function buildRootImage(): RootImage {
  const dev = new BlockDev(SPECS.sda)
  const fs = new CRFS(dev)
  const errors: string[] = []
  fs.format(LABEL)
  // 系统盘的根目录是 0755：只有 root 能在 / 下建删条目。
  // （可移动盘 format 保持 1777+sticky，当公共暂存区用。）
  fs.setFlags(1, MODE_DIR)
  fs.setOwner(1, UID_ROOT)

  const mkdirp = (path: string): number => {
    let ino = 1
    for (const seg of path.split('/').filter(Boolean)) {
      const found = fs.lookup(ino, seg)
      if (found) {
        ino = found
        continue
      }
      const made = fs.create(ino, seg, T_DIR)
      if (typeof made !== 'number') {
        errors.push(`${path}: ${made.err}`)
        return 0
      }
      ino = made
    }
    return ino
  }

  for (const path of DIRS) mkdirp(path)

  for (const [path, text] of FILES) {
    const parent = mkdirp(dirname(path))
    if (!parent) continue
    const ino = fs.create(parent, basename(path), T_FILE)
    if (typeof ino !== 'number') {
      errors.push(`${path}: ${ino.err}`)
      continue
    }
    const r = fs.write(ino, text)
    if (typeof r !== 'number') errors.push(`${path}: ${r.err}`)
  }

  for (const [path, driver] of DEVICES) {
    const parent = mkdirp(dirname(path))
    if (!parent) continue
    const ino = fs.create(parent, basename(path), T_DEV)
    if (typeof ino !== 'number') {
      errors.push(`${path}: ${ino.err}`)
      continue
    }
    fs.setDriver(ino, driver)
  }

  applySystemPolicy(fs)
  fs.markAccounts()
  return { bytes: dev.bytes, errors }
}
