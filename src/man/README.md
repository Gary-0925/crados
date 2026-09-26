# crados

The filesystem is bytes on a block device, the process table is bytes in RAM,
and every program in /bin is CRX machine code fetched through a page table.

## How a command runs

    timer interrupt
      -> scheduler picks a ready process (round robin, quantum 5)
      -> CPU fetches an instruction through the page table
      -> a sys instruction traps into the kernel

execve reads the inode, follows its block pointers, copies the image into
page frames, and only then starts the CPU. Watch it in dmesg.

## Filesystem

sda is the system disk, in the way C: is the system disk on Windows. It
holds the root tree and every program that ships with the OS.

    /bin        system programs, installed on sda at power-on
    /home/user  these documents
    /mnt        mount point for /dev/sdb
    /tmp        scratch
    /usr/bin    where your own programs go

## First steps

    ls -l /bin
    cat count.s
    as count.s -o count
    ./count
    ps

## Experiments

1. Scheduling. Run 'count 30 a &' then 'count 30 b'. The output
   interleaves because the scheduler preempts each process.
2. Blocking. Run 'sleep 8 &' then 'ps'. The sleeper is BLOCK, not
   consuming CPU.
3. Zombies. Run 'sleep 60 &', then 'kill <pid>', then 'ps'. It stays as
   <defunct> until its parent reaps it.
4. Out of memory. Run 'sleep 100 &' repeatedly until fork fails.
5. Permissions. The login shell is uid 1. 'kill 1' returns
   EPERM. Only euid 0 may signal init, and that still panics.
6. Redirection. Run 'echo hi > /tmp/a' then 'cat /tmp/a'.

## Manuals

    man man        this catalog, and how the pages are stored
    man asm        instruction set, assembler, syscalls
    man storage    disks and the on-disk format
    man inspect    memory, the process table, registers
    man script     shell scripts and the #! mechanism

Chinese versions: man README.zh, man asm.zh, and so on.
