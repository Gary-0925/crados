## crados 3.1 (Cradle OS) - a transparent OS

Try plain version at <https://gary-0925.github.io/crados/>, or transparent version at <https://gary-0925.github.io/crados/transparent>.

You could run `man` or `man README.zh` at <https://gary-0925.github.io/crados/transparent> to get more information，have fun!

`man`:

```text
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

    /bin        programs, mounted from /dev/rom
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
5. Permissions. The login shell is uid 1000. 'kill 1' returns
   EPERM. Only euid 0 may signal init, and that still panics.
6. Redirection. Run 'echo hi > /tmp/a' then 'cat /tmp/a'.

## Manuals

    man asm        instruction set, assembler, syscalls
    man storage    disks and the on-disk format
    man inspect    memory, the process table, registers
    man script     shell scripts and the #! mechanism

Chinese versions: man README.zh, man asm.zh, and so on.
```

`man README.zh`:

```text
# crados

文件系统是块设备上的字节，进程表是内存条里的字节，/bin 中的每个程序都是
经页表取指执行的 CRX 机器码。

## 一条命令是怎么跑起来的

    时钟中断
      -> 调度器挑一个就绪进程（轮转，时间片 5）
      -> CPU 经页表取指
      -> sys 指令陷入内核

execve 会读取 inode、顺着块指针把映像逐块拷进页帧，然后才启动 CPU。
这个过程在 dmesg 里能看到。

## 文件系统

    /bin        程序，由 /dev/rom 挂载
    /home/user  本目录下的文档
    /mnt        /dev/sdb 的挂载点
    /tmp        临时目录
    /usr/bin    存放你自己编译的程序

## 上手

    ls -l /bin
    cat count.s
    as count.s -o count
    ./count
    ps

## 实验

1. 调度。先后运行 'count 30 a &' 和 'count 30 b'，两者的输出会交错，
   因为调度器在抢占它们。
2. 阻塞。运行 'sleep 8 &' 再 'ps'，睡眠进程处于 BLOCK，不占用 CPU。
3. 僵尸。运行 'sleep 60 &'，再 'kill <pid>'，再 'ps'，它会以 <defunct>
   状态留存，直到父进程回收。
4. 内存耗尽。反复运行 'sleep 100 &'，直到 fork 失败。
5. 权限。登录 shell 是 uid 1000。运行 'kill 1' 得到 EPERM。
   只有 euid 0 可以信号 init，那样才会恐慌。
6. 重定向。运行 'echo hi > /tmp/a' 再 'cat /tmp/a'。

## 手册

    man asm        指令集、汇编器、系统调用
    man storage    磁盘与盘上格式
    man inspect    内存、进程表、寄存器
    man script     shell 脚本与 #! 机制

英文版：man README、man asm，以此类推。
```
