export const MOTD = `crados 1.0 (Cradle OS) - a transparent OS

Type 'help' for the command list, 'man' for the guided tour.
The right-hand panels are a live projection of kernel data structures.
`

export const README = `crados(7) - system overview

DESCRIPTION
  A single-core, tick-driven kernel. Every command you type crosses the
  user/kernel boundary through a system call, and the panels on the right
  show that boundary as it is crossed.

  timer interrupt (20 Hz) -> scheduler (round robin, quantum 5)
                          -> current process runs until its next syscall

  process  PCB with page table, registers, open file table, state machine
  memory   64 frames x 256 B of real bytes; allocated on spawn, freed on exit

EXECUTION PATH
  Nothing runs from disk. execve(2) reads the inode, follows its block
  pointers, copies the image block by block into the page frames it just
  allocated, and only then starts the CPU, which fetches every instruction
  from memory through the page table. dmesg shows the copy for each exec:
    execve: /usr/bin/hello read 1 block(s) from sda, 44 bytes into memory
  storage  /dev/sda root disk (persisted in the browser)
           /dev/sdb removable disk (mount, export, import)
  program  a file under /bin; exec loads it from the disk

EXPERIMENTS
  1  scheduling     count 30 a &   then   count 30 b
  2  blocking I/O   sleep 8 &      then   ps
  3  zombies        sleep 60 &     then   kill <pid>   then   ps
  4  out of memory  run 'sleep 100 &' repeatedly until fork fails
  5  panic          kill 1
  6  devices        cat /dev/tty   (reads lines until Ctrl-D)
  7  redirection    echo hello > /tmp/a.txt ; cat /tmp/a.txt

SEE ALSO
  man asm        writing real executables in assembly
  man storage    disks, mounting, import and export
  man script     shell scripts and the #! mechanism
  man inspect    reading raw memory and disk bytes
`

export const HELLO_S = `; hello.s - assemble with: as hello.s -o hello
.text
_start:
    mov r0, 1          ; syscall 1 = write
    mov r1, 1          ; fd 1 = stdout
    mov r2, msg        ; buffer address
    mov r3, 0          ; length 0 = up to the NUL byte
    sys
    mov r1, 0          ; exit status
    hlt

.data
msg:
    .asciz "hello from a real binary\\n"
`

export const COUNT_S = `; count.s - a loop, a syscall and a sleep
; build:  as count.s -o count      run:  ./count
.text
_start:
    mov r4, 0              ; counter
    mov r6, 0              ; base register for absolute stores
loop:
    cmp r4, 10
    jgt done

    mov r5, r4             ; render the digit into the buffer
    add r5, 48             ; 48 is ASCII '0'
    stb [r6+digit], r5     ; self-modifying data, written through the MMU
    mov r0, 1
    mov r1, 1
    mov r2, digit
    mov r3, 2
    sys

    mov r0, 6              ; syscall 6 = sleep
    mov r1, 4              ; 4 timer ticks, the process blocks
    sys

    add r4, 1
    jmp loop
done:
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 0
    sys
    mov r1, 0
    hlt

.data
digit:
    .byte 48
    .byte 32
    .byte 0
nl:
    .asciz "\\n"
`

export const MAN_ASM = `asm(7) - writing real executables

A program in /bin is not special. It is a file whose first four bytes are
the magic number \\x7fCRX, with the execute bit set. Assemble one yourself
and it is loaded, paged and scheduled exactly like the system utilities.

ALL PROGRAMS ARE NATIVE
  Every regular file in /bin is a CRX image. This includes pid 1 init, the
  interactive and script-mode shell, the assembler, ps, the disk tools and
  the inspection tools. There is no function-entry table and execve has no
  host-language fallback path. objdump /bin/init shows the program that
  started the system; objdump /bin/sh shows the parser handling redirection,
  background jobs, built-ins, PATH search and waitpid in userspace.

  Making them native required a byte-oriented ABI, because machine code
  cannot consume a structured value. read(2) takes a buffer length and
  returns only that much; getdents(2) fills a buffer with 16-byte records,
  15 bytes of NUL-padded name plus a type byte; getcwd(2) and getenv(2)
  fill a buffer and return the length. That is why these calls look the
  way they do on a real system.

  Text tables such as ps and df are exposed by the kernel as read-only
  pseudo-file views, analogous to /proc and /sys. Their CRX frontends read
  those bytes and write them to stdout. The assembler frontend invokes the
  same encoding service used to build the boot ROM, then writes the returned
  CRX bytes to a normal inode. The executable process is machine code in both
  cases; no ProgramFn or JavaScript command implementation remains.

SYSTEM CALL NUMBERS
   1 write(fd,buf,len)    2 read(fd,buf,max)    3 exit(status)
   4 open(path,mode)      5 close(fd)           6 sleep(ticks)
   7 getpid()             8 gethz()             9 spawn(path)
  10 wait(pid)           11 getdents(path,buf,max)
  12 getcwd(buf)         13 unlink(path)       14 mkdir(path)
  15 chmod(path,x)       16 rename(from,to)    17 sync()
  18 getenv(key,buf)     20 mount(dev,dir)     21 umount(target)
  22 kill(pid,sig)       23 chdir(path)        24 dup(fd)
  25 dup2(old,new)       26 readview(kind,buf) 27 assemble(src,out)
  28 tcsetpgrp(pid)

BUILD AND RUN
  $ as hello.s -o hello     assemble; the execute bit is set for you
  $ ./hello                 run it from the current directory
  $ cp hello /bin/          install it
  $ hello                   now found on PATH, like ls or ps
  $ ls -l /bin              identical -rwxr-xr-x mode to the built-ins
  $ objdump hello           disassemble the text section

MACHINE
  8 general registers r0-r7, each 16 bits. Fixed 4-byte instructions.
  Flags are set by cmp and tested by je, jne, jlt, jgt.
  The address space starts at 0: .text at 0, .data after it, stack on top.
  Every fetch and load goes through the page table; a bad address raises a
  page fault and the kernel kills the process, just like SIGSEGV.

INSTRUCTIONS
  mov add sub mul div mod cmp   rD, rS or rD, imm
  jmp je jne jlt jgt call ret   control flow
  ldb rD, [rB+off]              load byte
  stb [rB+off], rS              store byte
  push rS | push imm | pop rD   stack
  sys                           trap into the kernel
  hlt                           stop; r1 is the exit status

DIRECTIVES
  .text  .data  .asciz "str"  .ascii "str"  .byte n  .word n  .space n
  _start is the entry point if defined, otherwise address 0.

SYSTEM CALL ABI
  r0 holds the call number, r1-r3 the arguments, r0 receives the result.
    1 write(fd, buf, len)   len 0 means up to the NUL terminator
    2 read(fd, buf, max)    returns length, 0xffff at end of file
    3 exit(status)
    4 open(path, mode)      mode 0 read, 1 write, 2 append
    5 close(fd)
    6 sleep(ticks)
    7 getpid()
    9 spawn(path)
   10 wait(pid)

EXAMPLE
  See /home/user/hello.s and /home/user/count.s for working sources.
`

export const MAN_INSPECT = `inspect(7) - looking at raw storage

Every abstraction in this system is backed by real bytes. Physical memory is
a 16 KiB array; a page table entry is an index into it. A disk image is a
block array whose first block is the superblock.

FROM THE SHELL
  hexdump file            dump the bytes of a regular file
  hexdump -p 0x0000 256   dump physical memory at an address
  hexdump -p 0x0100       the kernel process table, as stored in frame 1

  Frame 0 holds the boot record, frame 1 the process table. Both are
  rewritten by the kernel whenever a process is created or reaped, so a
  dump of frame 1 always matches the output of ps.

THE PROCESS TABLE IS IN RAM
  Frame 0 is the boot record. Frames 1 to 4 hold the process table: 32
  slots of 128 bytes, one per task. The fields are

    0    in use        1     state         2-3   pid        4-5   ppid
    6-7  pc            8-9   sp            10-11 ax         12-13 exit
    14-15 cpu ticks    16-17 wake tick     18-19 wait for   20    on stdin
    21   page count    22    cwd device    23    cwd inode  24-39 page table
    40   fd count      41-88 fd table      89-105 name      106-127 command

  The kernel does not keep a second copy of any of this. ps(1) reads these
  bytes, and so does the process panel. Run 'hexdump -p 0x0100' to see the
  slot belonging to init, then compare it with ps.

  Note how cwd is stored: two bytes, a device and an inode number. The
  path text is rebuilt on demand by walking parent links on disk, which is
  what a real kernel does with its dentry pointer.

FROM THE PANELS
  The Memory panel shows the frame bitmap, the MMU translator and the
  bytes of one frame together. Type a virtual address, press the button
  next to the result, and the frame it maps to is dumped with the target
  byte highlighted. Each process owns a hue, grey is kernel, outlined
  cells are free.

  The Storage panel does the same for disks. Pick a device, click a block
  to dump it, or select a file in the inode tree: its data blocks are
  ringed in the map and its block pointers become buttons that jump
  straight to the bytes. Amber is the superblock, orange a bitmap, purple
  the inode table, blue a directory record, green file data.

WHAT YOU WILL SEE
  A process code page contains the literal source text of the program that
  was loaded into it. The stack page starts with the argv vector written by
  the loader. Freed frames are scrubbed on the next allocation, so a newly
  allocated page never leaks the previous tenant's data.
`

export const MAN_STORAGE = `storage(7) - disks, the on-disk format, import and export

ON-DISK FORMAT (CRFS)
  A disk is an array of bytes and nothing else. Every structure below is a
  field inside those bytes; there is no copy of the tree held anywhere.

    block 0        superblock: magic "CRFS", block size, block count,
                   inode count, inode table start, data start, label
    block 1        block bitmap, one bit per block
    block 2        inode bitmap, one bit per inode
    block 3..k     inode table, 32 bytes per inode
    block k+1..    data blocks

  An inode is laid out as
    offset 0   type    1 = file, 2 = directory, 3 = device
    offset 1   flags   bit 0 is the execute bit
    offset 2   size    16-bit length in bytes
    offset 4   parent  inode number of the containing directory
    offset 6   driver  device node minor number
    offset 8   ptr[12] twelve direct block pointers

  WHERE DOES A FILE START AND END?  The block pointers say which blocks
  hold the file; they need not be adjacent. The size field says how far
  into the last block the file runs. Nothing is stored inline and no
  terminator byte is used: extent = pointer list, end = size. A file is
  therefore capped at 12 blocks. A directory is an ordinary file whose
  data is a run of 16-byte records, each holding a 2-byte inode number and
  a 14-byte name; deleting a name rewrites that run.

  Watch it happen: write a file, then select it in the Storage panel's
  inode tree. Its blocks are ringed in the block map and listed as inode
  pointers; the bitmap block has a bit set and the data block holds the
  bytes you just wrote.

DEVICES
  /dev/rom   firmware, 256 blocks x 1024 B, mounted at /bin
  /dev/sda   root disk, 192 blocks x 256 B, mounted at /
             dirty blocks are written back to browser storage automatically
  /dev/sdb   removable disk, 64 blocks x 256 B, not mounted at boot

MOUNTING
  lsblk                    list block devices and mount points
  mount /dev/sdb /mnt      graft the disk image onto the /mnt directory
  cp notes.txt /mnt/       copy a file onto the removable disk
  umount /mnt              flush the image and detach the subtree

WRITEBACK
  There is no sync command. The kernel tracks a dirty flag and flushes
  every modified device to browser storage about once a second, on
  unmount, on panic and on shutdown. The Storage panel shows whether the
  current state has reached the store yet. sync(2) still exists as call
  17 for programs that want to force a flush.

HOST TRANSFER
  The Storage panel saves /dev/sdb to your computer as a .img file. That
  file is a byte-for-byte copy of the medium, superblock first, exactly
  what a disk imaging tool would produce. Loading it back restores the
  medium; the kernel refuses images whose superblock magic is wrong.

NOTES
  Unmount before removing the disk; the kernel refuses to detach a busy
  device with EBUSY. Writes past the end of a disk fail with ENOSPC.
`

export const MAN_SCRIPT = `script(7) - creating an executable

A file becomes a program in two steps: give it a #! interpreter line, then
set the execute bit. This is exactly what execve(2) does on a real system.

  $ cat > hello.sh
  #!/bin/sh
  echo hello from a script
  ls -l /bin
  <Ctrl-D>

  $ chmod +x hello.sh
  $ ./hello.sh

HOW IT WORKS
  cat with no argument reads standard input; the shell has redirected fd 1
  into the new file, so your keystrokes land on the disk. Ctrl-D closes the
  stream. chmod sets the x bit on the inode. When you run ./hello.sh the
  kernel reads the first line, finds #!/bin/sh, and spawns /bin/sh with the
  script path as argv[0]; the shell then executes each line in turn.

  Without the execute bit exec fails with EACCES; without a #! line it
  fails with ENOEXEC. Scripts may live on the removable disk as well.
`
