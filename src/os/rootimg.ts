// Builds the initial sda byte image from a declarative file table.

import { BlockDev, SPECS } from './blockdev'
import { basename, CRFS, dirname, DRV_NULL, DRV_TTY, T_DEV, T_DIR, T_FILE } from './fs'
import {
  COUNT_S,
  BLOCK_S,
  DOC_ASM,
  DOC_ASM_ZH,
  DOC_INSPECT,
  DOC_INSPECT_ZH,
  DOC_README,
  DOC_README_ZH,
  DOC_SCRIPT,
  DOC_SCRIPT_ZH,
  DOC_STORAGE,
  DOC_STORAGE_ZH,
  HELLO_S,
  PAGE_S,
} from './rootfs'

const LABEL = 'crados-root'

// /bin 是 ROM 的挂载点，/mnt 是建议的可移动盘挂载点；根盘上都只是空目录
const DIRS = ['/bin', '/dev', '/usr', '/usr/bin', '/mnt', '/tmp', '/home', '/home/user']

const FILES: [string, string][] = [
  ['/home/user/README.md', DOC_README],
  ['/home/user/README.zh.md', DOC_README_ZH],
  ['/home/user/asm.md', DOC_ASM],
  ['/home/user/asm.zh.md', DOC_ASM_ZH],
  ['/home/user/storage.md', DOC_STORAGE],
  ['/home/user/storage.zh.md', DOC_STORAGE_ZH],
  ['/home/user/inspect.md', DOC_INSPECT],
  ['/home/user/inspect.zh.md', DOC_INSPECT_ZH],
  ['/home/user/script.md', DOC_SCRIPT],
  ['/home/user/script.zh.md', DOC_SCRIPT_ZH],
  ['/home/user/hello.s', HELLO_S],
  ['/home/user/count.s', COUNT_S],
  ['/home/user/page.s', PAGE_S],
  ['/home/user/block.s', BLOCK_S],
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

  return { bytes: dev.bytes, errors }
}
