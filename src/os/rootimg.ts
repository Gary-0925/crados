// Builds the initial sda byte image from a declarative file table.

import { BlockDev, SPECS } from './blockdev'
import { applyLoginPolicy, basename, CRFS, dirname, DRV_NULL, DRV_TTY, T_DEV, T_DIR, T_FILE } from './fs'
import { MAN_FILES } from '../man'
import {
  COUNT_S,
  BLOCK_S,
  HELLO_S,
  PAGE_S,
} from './rootfs'

const LABEL = 'crados-root'

const DIRS = ['/bin', '/dev', '/usr', '/usr/bin', '/usr/man', '/mnt', '/tmp', '/home', '/home/user']

const FILES: [string, string][] = [
  ...MAN_FILES,
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

  applyLoginPolicy(fs)
  return { bytes: dev.bytes, errors }
}
