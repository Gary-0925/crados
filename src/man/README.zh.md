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

sda 是系统盘，地位相当于 Windows 里的 C 盘：根目录树和所有随系统
发行的程序都在这块盘上。

    /bin        系统程序，每次上电安装到 sda
    /usr/man    本手册
    /home/user  你自己的文件和示例源码
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
5. 权限。登录 shell 是 uid 1。运行 'kill 1' 得到 EPERM。
   只有 euid 0 可以信号 init，那样才会恐慌。
6. 重定向。运行 'echo hi > /tmp/a' 再 'cat /tmp/a'。

## 手册

    man man        本目录，以及手册页是怎么存放的
    man asm        指令集、汇编器、系统调用
    man storage    磁盘与盘上格式
    man inspect    内存、进程表、寄存器
    man script     shell 脚本与 #! 机制

英文版：man README、man asm，以此类推。
