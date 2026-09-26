# inspect

Every abstraction here is backed by real bytes. Physical memory is a
64 KiB array, 256 frames of 256 bytes; a page table entry is an index
into it. A disk image is a block array whose first block is the superblock.

## From the shell

    hexdump file            dump the bytes of a regular file
    objdump prog            disassemble a CRX executable
    mem                     frame usage per process
    ps                      the process table

## The process table is in RAM

Frame 0 is the boot record. Frames 1 to 12 hold the process table: 16
slots of 192 bytes, one per task.

    0     in use       1     state        2-3   pid
    4-5   ppid         6-7   pc           8-9   sp
    12-13 exit status  14-17 reserved     18-19 wait for
    20    on stdin     21    page count   22    cwd device
    23    cwd inode    24-39 page table   40    fd count
    41-88 fd table     89-105 name        106-127 command
    128-143 r0-r7      144-145 flags      146   halted
    147-154 cpu ticks  155-162 wake deadline     163 sleep mode
    176-177 uid       178-179 euid            180-183 reserved
    184-185 frame bit 6                       186-187 frame bit 7

CPU tick counters are stored in 64-bit PCB fields. The host performs exact
arithmetic throughout JavaScript's 53-bit safe range. Sleep mode 1 stores a
Guest tick deadline, so MAX shortens sleep(ticks). Mode 2 stores a monotonic
millisecond deadline for sleep_seconds(), so the sleep command keeps real
seconds unchanged at every CPU speed.

The kernel keeps no second copy. ps reads these bytes, and so does the
process panel.

Note how cwd is stored: two bytes, a device and an inode number. The path
text is rebuilt on demand by walking parent links on disk, which is what a
real kernel does with its dentry pointer.

Registers are not JavaScript values either. The CPU state is a set of
accessors onto bytes 128-146 of the PCB, so every instruction reads and
writes that physical register bank. The MMU likewise reads a frame number
on every fetch: the low 6 bits live in bytes 24-39, and bits 6 and 7 are
the corresponding bit of the masks at 184 and 186. The frame bitmap is
the last 32 bytes of frame 0.

## From the panels

The Memory panel shows the frame bitmap, the MMU translator and the bytes
of one frame together. Type a virtual address, press the button beside the
result, and the frame it maps to is dumped with the target byte
highlighted. Each process owns a hue; outlined cells are free.

The Storage panel does the same for disks. Pick a device, click a block,
or select a file in the inode tree: its data blocks are ringed in the map
and its block pointers become buttons that jump to the bytes.

## What you will see

A code page holds the CRX image that was loaded into it. The stack page
starts with the argv vector written by the loader. Freed frames are
scrubbed on the next allocation, so a fresh page never leaks the previous
tenant's data.
