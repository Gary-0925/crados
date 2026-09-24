## crados 1.0 (Cradle OS) - a transparent OS

All the information are in `/home/user/` at <https://gary-0925.github.io/crados/>，explore them in your own!

`/home/user/README`:

```text
crados(7) - system overview

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
```
