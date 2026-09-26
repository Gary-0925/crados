# storage

A disk is an array of bytes and nothing else. Every structure below is a
field inside those bytes; no copy of the tree is held anywhere else.

## On-disk format

    block 0        superblock: magic "CRFS", block size, block count,
                   inode count, inode table start, data start, label
    block 1        block bitmap, one bit per block
    block 2        inode bitmap, one bit per inode
    block 3..k     inode table, 48 bytes per inode
    block k+1..    data blocks

An inode is laid out as

    offset 0   type    1 file, 2 directory, 3 device
    offset 1   flags   bit0 owner exec, bit1 owner read, bit2 owner write,
                       bit3 other read, bit4 other write, bit5 setuid,
                       bit6 sticky, bit7 other exec. Shown as rwxrwxst.
                       chmod [u|o|a][+|-][rwxst] file. x follows u/o/a.
                       Owner or root only. Non-root cannot set setuid.
    offset 2   size    16-bit length in bytes
    offset 4   parent  inode number of the containing directory
    offset 6   driver  device node minor number
    offset 8   ptr[20] twenty direct block pointers

Owner uids live in the superblock, at byte 32 plus inode*2, one
big-endian u16 each. The login shell is uid 1. uid 0 bypasses the
checks. /bin is root-owned like any system directory: a non-root user
cannot create, delete or rewrite entries there, because permission is
checked against ownership, not against a firmware flag. block_read and
block_write require euid 0. A file created by a process is owned by that
euid. /home/user and /usr/bin are sticky, so a user cannot unlink root's
files. mv requires write permission on both the source and destination
directories. A regular file's mode is the intersection of its own flags
and its parent directory's flags: it cannot grant a bit the directory
does not have. PATH searches /bin before /usr/bin, so a program in
/usr/bin cannot shadow ls.

ls -l shows the mode, the owner, the size and the name of each entry.
The owner is read from that uid table: uid 0 is shown as root, uid 1 as
user, every other uid as a number. The line comes from readview
kind 8, so ls only needs search permission on the directories, not read
permission on the file.

Both calls ls makes, getdents and readview kind 8, run entirely in the
CRX kernel. Its read-only VFS walks inodes and directory blocks on any
device, crossing mount points through a table at 0x00C0 in the KCB.
ps, mem, help, lsblk, df, dmesg and hexdump are formatted by that kernel.
objdump checks the path itself, then asks the host to decode instructions.

    -rwxr-x-- root    464 cat
    drwxrwx-t root      0 tmp/

## Where a file starts and ends

The block pointers say which blocks hold the file; they need not be
adjacent. The size field says how far into the last block the file runs.
Nothing is stored inline and no terminator is used: extent is the pointer
list, end is size. A file is therefore capped at 20 blocks, 5120 bytes on
a 256 B disk.

There are no indirect blocks. Growing past the limit returns EFBIG, which
is what a real filesystem does when it runs out of addressing depth.

A directory is an ordinary file whose data is a run of 16-byte records,
each holding a 2-byte inode number and a 14-byte name. Deleting a name
rewrites that run.

## Devices

    /dev/sda   system disk, 2048 blocks x 256 B (512 KiB), mounted at /
    /dev/sdb   first imported or created disk, same geometry as sda
    /dev/sdc   the next one, and so on

Only sda exists at boot, holding the root tree and the installed
programs. Importing an image or creating a blank disk allocates the next
free name; each one is a separate device.

## Mounting

    lsblk                    list block devices
    df                       usage per filesystem
    mount /dev/sdb /mnt      attach the device to a directory
    cp /usr/man/README.md /mnt/   copy a file onto it
    umount /mnt              detach it

Any device can be mounted anywhere, and several can be mounted at once
on different directories. Mounting a second device over /bin or / is
rejected by the checks above.

Unmount before removing a disk; the kernel refuses to detach a busy
device with EBUSY. Writes past the end of a disk fail with ENOSPC.
A rename across devices fails with EXDEV, because rename only rewrites a
directory entry. Use cp for that.

## Writeback

There is no sync command. The kernel tracks a dirty flag and flushes
modified devices to browser storage about once a second, on unmount, on
panic and on shutdown. The Storage panel shows whether the current state
has reached the store. sync(2) still exists as call 17.

## Host transfer

The Storage panel saves the selected device as <name>.img, a byte-for-byte
copy with the superblock first, so sda exports as sda.img. Importing an
image never overwrites a device: it is attached as the next free name.
Images whose superblock does not match the on-disk format are refused.
