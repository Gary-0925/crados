## crados 5.0 (Cradle OS) - a transparent OS

Try plain version at <https://gary-0925.github.io/crados/>, or transparent version at <https://gary-0925.github.io/crados/transparent>.

You could run `man` or `man man.zh` at <https://gary-0925.github.io/crados/transparent> to get more information，have fun!

## Booting

The machine's own firmware asks where the system disk comes from before any OS
exists, because picking a boot medium is a hardware question — UEFI asks the same
one. The three answers are the whole point of the choice:

- from IndexedDB : the disk saved in this browser — files and edits intact
- from a .img file : an exported image as the system disk (ext2, matching geometry)
- new empty disk : format one and install the factory system

All three re-install `/bin` so the shipped programs always match the running
firmware, and all three re-attach the removable disks stored in IndexedDB.
A short image is zero-padded to the disk and one that does not fit is refused —
the same as writing an image to a real disk. Whether the bytes on it are a usable
ext2 system is the OS's own business, checked after power-on. While you work,
changed 16 KiB chunks are written back to IndexedDB about once a second (and on
unmount, panic and shutdown). The Storage panel still exports any device as a
`.img`, and that export is what you feed back in on the next boot.

## Layout

The project is exactly three parts, one folder each, with nothing kept around for
the sake of another part:

- `src/hw` : the machine: CPU and ISA, RAM, disks (bytes, IndexedDB,
             .img import/export), boot media and power-on, console
             (screen, keyboard, UART registers), hardware clock and
             interrupts, bus, MMU, block controller.  hw/ui is its
             front panel and firmware: display, keyboard, power-on
             menu.

- `src/os` : crados itself: boot loader, process table, scheduler,
             system calls, VFS and ext2, accounts, /bin sources,
             manuals, and the CRX kernel that runs in supervisor mode.

- `src/cp` : the transparent panel: the snapshot layer and the five
             panels.  The plain build leaves the whole folder out.

`src/Plain.tsx` assembles machine + OS; `src/Transparent.tsx` adds the
panel on top; `src/App.tsx` picks the one to build (that is the line the deploy
workflow rewrites, so the path stays where CI expects it).  Who may import whom, and why the
boundary sits where it does, is written down in `docs/architecture.md`.

## Development

```bash
npm ci          # install dependencies
npm run dev     # plain build on http://localhost:5173
npm run parts   # the three part boundaries, checked against the import graph
npm run check   # typecheck + parts + smoke + IndexedDB persistence + ext2 tests
```

The transparent build is produced by CI, which rewrites `src/App.tsx` to point at
`src/Transparent.tsx`. For local work on the control panel, change that line by hand.
The CI build also fails if the panel leaks into the plain bundle (it greps the
built page for `crados/control-panel`, the panel's own tag).
