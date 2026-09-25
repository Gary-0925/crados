// /home/user 下的初始文档。
// 单个文件上限是 20 个直接块 × 256 B = 5120 字节；中文按 UTF-8 每字 3 字节计算。
// 文档用缩进式代码块而非围栏式，避免与 JS 模板字符串的反引号冲突。

export const DOC_README = `# crados

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
`

export const DOC_README_ZH = `# crados

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
`

export const DOC_ASM = `# asm

A program in /bin is not special. It is a file whose first four bytes are
the magic number \\x7fCRX, with the execute bit set. Assemble one and it is
loaded, paged and scheduled exactly like the system utilities.

## Build and run

    as hello.s -o hello    assemble; the execute bit is set for you
    ./hello                run it from the current directory
    cp hello /usr/bin/     install it
    hello                  now found on PATH, like ls or ps
    objdump hello          disassemble the text section

## Machine

Eight 16-bit registers r0-r7. Fixed four-byte instructions. Flags are set
by cmp and tested by je, jne, jlt, jgt. The address space starts at 0:
.text first, then .data, with the stack on the top page. Every fetch and
load goes through the page table; a bad address raises a page fault and
the kernel kills the process, just as SIGSEGV would.

## Instructions

    mov add sub mul div mod cmp   rD, rS or rD, imm
    jmp je jne jlt jgt call ret   control flow
    ldb rD, [rB+off]              load byte
    stb [rB+off], rS              store byte
    ldw rD, [rB+off]              load 16-bit word
    stw [rB+off], rS              store 16-bit word
    push rS | push imm | pop rD   stack
    sys                           trap into the kernel
    hlt                           stop; r1 is the exit status

## Directives

    .text  .data  .asciz "s"  .ascii "s"  .byte n  .word n  .space n

_start is the entry point if defined, otherwise address 0.

## Calling convention

On entry r1 holds argc and r2 points at the argv block, where arguments
are separated by NUL bytes. For a syscall, r0 holds the call number and
r1-r3 the arguments; r0 receives the result. 0xffff means failure.

## System calls

     1 write(fd,buf,len)    len 0 means up to the NUL terminator
     2 read(fd,buf,max)     returns length, 0xffff at end of file
     3 exit(status)         4 open(path,mode)   mode 0 r, 1 w, 2 a
     5 close(fd)            6 sleep(ticks)      7 getpid()
     8 gethz()              9 spawn(path,argv,argc)
    10 wait(pid)           11 getdents(path,buf,max)
    12 getcwd(buf)         13 unlink(path)     14 mkdir(path)
    15 chmod(path,set,clr)       16 rename(from,to)  17 sync()
    18 getenv(key,buf)     20 mount(dev,dir)   21 umount(target)
    22 kill(pid,sig)       23 chdir(path)      24 dup(fd)
    25 dup2(old,new)       26 readview(kind,arg,buf)
    27 assemble(src,out)   28 tcsetpgrp(pid)
    29 page_alloc(vpn)     30 clock_gettime()   31 page_free(vpn)
    32 block_read(dev,blk,buf)   33 block_write(dev,blk,buf)
    34 sleep_seconds(seconds)

getdents fills a buffer with 16-byte records: 15 bytes of NUL-padded name
plus one type byte. That is why these calls take a buffer and a length.

## Sources

See hello.s and count.s in this directory.
`

export const DOC_ASM_ZH = `# asm

/bin 里的程序并不特殊：它只是一个头四字节为魔数 \\x7fCRX、并且置了执行位的
文件。你汇编出来的程序，会以和系统工具完全相同的方式被加载、分页和调度。

## 构建与运行

    as hello.s -o hello    汇编，执行位会自动置上
    ./hello                在当前目录运行
    cp hello /usr/bin/     安装
    hello                  现在和 ls、ps 一样能在 PATH 里找到
    objdump hello          反汇编 text 段

## 机器模型

八个 16 位寄存器 r0-r7，定长四字节指令。cmp 置标志位，由 je、jne、jlt、
jgt 测试。地址空间从 0 开始：先 .text，再 .data，栈在最高一页。每次取指和
访存都要过页表；非法地址触发缺页，内核会杀掉进程，等同于 SIGSEGV。

## 指令

    mov add sub mul div mod cmp   rD, rS 或 rD, imm
    jmp je jne jlt jgt call ret   控制流
    ldb rD, [rB+off]              读字节
    stb [rB+off], rS              写字节
    ldw rD, [rB+off]              读 16 位字
    stw [rB+off], rS              写 16 位字
    push rS | push imm | pop rD   栈操作
    sys                           陷入内核
    hlt                           停机，r1 为退出码

## 伪指令

    .text  .data  .asciz "s"  .ascii "s"  .byte n  .word n  .space n

定义了 _start 就以它为入口，否则从地址 0 开始。

## 调用约定

入口处 r1 是 argc，r2 指向 argv 区，各参数以 NUL 分隔。系统调用时 r0 放
调用号，r1-r3 放参数，返回值在 r0，0xffff 表示失败。

## 系统调用

     1 write(fd,buf,len)    len 为 0 表示写到 NUL 为止
     2 read(fd,buf,max)     返回长度，0xffff 表示文件结束
     3 exit(status)         4 open(path,mode)   mode 0 读 1 写 2 追加
     5 close(fd)            6 sleep(ticks)      7 getpid()
     8 gethz()              9 spawn(path,argv,argc)
    10 wait(pid)           11 getdents(path,buf,max)
    12 getcwd(buf)         13 unlink(path)     14 mkdir(path)
    15 chmod(path,set,clr)       16 rename(from,to)  17 sync()
    18 getenv(key,buf)     20 mount(dev,dir)   21 umount(target)
    22 kill(pid,sig)       23 chdir(path)      24 dup(fd)
    25 dup2(old,new)       26 readview(kind,arg,buf)
    27 assemble(src,out)   28 tcsetpgrp(pid)
    29 page_alloc(vpn)     30 clock_gettime()   31 page_free(vpn)
    32 block_read(dev,blk,buf)   33 block_write(dev,blk,buf)
    34 sleep_seconds(seconds)

机器码无法消费结构化的值，所以 read、getdents、getcwd、getenv 一律采用
「缓冲区 + 长度」的形式。getdents 填的是 16 字节定长记录：15 字节 NUL
补齐的名字加一字节类型。真实 Unix 这样设计，也是同一个原因。

## 示例

本目录下的 hello.s 与 count.s。
`

export const DOC_STORAGE = `# storage

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
                       Owner or root, not firmware
    offset 2   size    16-bit length in bytes
    offset 4   parent  inode number of the containing directory
    offset 6   driver  device node minor number
    offset 8   ptr[20] twenty direct block pointers

Owner uids live in the superblock, at byte 32 plus inode*2, one
big-endian u16 each. The login shell is uid 1000. uid 0 bypasses the
checks. /bin is firmware: syscall writes return EROFS. block_write
requires euid 0. A file created by a process is owned by that euid.
/home/user and /usr/bin are sticky, so a user cannot unlink root's files.
PATH searches /bin before /usr/bin, so a program in /usr/bin cannot
shadow ls.

## Where a file starts and ends

The block pointers say which blocks hold the file; they need not be
adjacent. The size field says how far into the last block the file runs.
Nothing is stored inline and no terminator is used: extent is the pointer
list, end is size. A file is therefore capped at 20 blocks: 5120 bytes on
sda, 20480 on rom, whose blocks are 1024 B.

There are no indirect blocks. Growing past the limit returns EFBIG, which
is what a real filesystem does when it runs out of addressing depth.

A directory is an ordinary file whose data is a run of 16-byte records,
each holding a 2-byte inode number and a 14-byte name. Deleting a name
rewrites that run.

## Devices

    /dev/rom   firmware, 256 blocks x 1024 B, mounted at /bin
    /dev/sda   root disk, 2048 blocks x 256 B (512 KiB), mounted at /
    /dev/sdb   first imported or created disk, same geometry as sda
    /dev/sdc   the next one, and so on

Only sda and rom exist at boot. Importing an image or creating a blank
disk allocates the next free name; each one is a separate device.

## Mounting

    lsblk                    list block devices
    df                       usage per filesystem
    mount /dev/sdb /mnt      attach the device to a directory
    cp README.md /mnt/       copy a file onto it
    umount /mnt              detach it

Any device except rom can be mounted anywhere, and several can be mounted
at once on different directories.

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
copy with the superblock first, so sda exports as sda.img and rom as
rom.img. Importing an image never overwrites a device: it is attached as
the next free name. Images whose superblock does not match the on-disk
format are refused.
`

export const DOC_STORAGE_ZH = `# storage

磁盘就是一个字节数组，此外别无他物。下面所有结构都是这些字节里的字段，
别处不存在任何一份目录树的副本。

## 盘上格式

    块 0         超级块：magic "CRFS"、块大小、块数、inode 数、
                 inode 表起始、数据区起始、卷标
    块 1         块位图，每块一个 bit
    块 2         inode 位图，每个 inode 一个 bit
    块 3..k      inode 表，每个 inode 48 字节
    块 k+1..     数据块

inode 的布局：

    偏移 0    type    1 文件，2 目录，3 设备
    偏移 1    flags   bit0 属主执行，bit1 属主读，bit2 属主写，
                      bit3 其他人读，bit4 其他人写，bit5 setuid，
                      bit6 sticky，bit7 其他人执行。显示为 rwxrwxst。
                      chmod [u|o|a][+|-][rwxst] file，x 也看 u/o/a。
                      属主或 root 可以改，固件不行
    偏移 2    size    16 位字节长度
    偏移 4    parent  所在目录的 inode 号
    偏移 6    driver  设备号
    偏移 8    ptr[20] 二十个直接块指针

属主 uid 在超级块里，字节 32 起每个 inode 一个大端 u16。登录 shell 是
uid 1000。uid 0 跳过检查。/bin 是固件，系统调用写它返回 EROFS。
block_write 需要 euid 0。进程创建的文件属主就是它的 euid。/home/user
和 /usr/bin 带 sticky，用户删不掉 root 的文件。PATH 先搜 /bin 再搜
/usr/bin，所以 /usr/bin 里的程序不能盖住 ls。

## 文件的起止是怎么标记的

块指针给出文件占用了哪些块，它们不要求相邻；size 字段给出最后一块用到第
几字节。既不内联存储，也不使用结束符：范围由指针表决定，末端由 size 决定。
因此单个文件上限为 20 块：sda 上是 5120 字节，rom 的块是 1024 B，上限为
20480 字节。

没有间接块。超出上限会返回 EFBIG，真实文件系统在寻址深度用尽时也是如此。

目录也是普通文件，其数据是一串 16 字节记录，每条含 2 字节 inode 号和
14 字节名字。删除一个名字就是重写这段数据。

## 设备

    /dev/rom   固件，256 块 x 1024 B，挂载于 /bin
    /dev/sda   根盘，2048 块 x 256 B（512 KiB），挂载于 /
    /dev/sdb   第一个导入或新建的磁盘，容量与 sda 相同
    /dev/sdc   下一个，以此类推

开机时只有 sda 和 rom。导入镜像或新建空盘会占用下一个空闲名字，
每一个都是独立设备。

## 挂载

    lsblk                    列出块设备
    df                       各文件系统用量
    mount /dev/sdb /mnt      把设备接入目录树
    cp README.md /mnt/       复制文件到该设备
    umount /mnt              摘除

除 rom 外的设备都可以挂到任意目录，也可以同时挂载多个。

拔盘前先 umount；设备忙时内核会返回 EBUSY。写满返回 ENOSPC。跨设备的
rename 返回 EXDEV，因为 rename 只改写目录项，跨设备请用 cp。

## 回写

没有 sync 命令。内核维护脏标志，大约每秒把被修改的设备写回浏览器存储，
umount、内核恐慌和关闭页面时也会强制写回。存储面板会显示当前状态是否
已经落盘。sync(2) 作为 17 号调用仍然保留。

## 与宿主交换

存储面板可以把当前选中的设备保存为 <设备名>.img，那是整盘逐字节的副本，
超级块在最前，所以 sda 导出为 sda.img，rom 导出为 rom.img。导入镜像不会
覆盖任何设备，而是挂到下一个空闲名字上。盘上格式不匹配的镜像会被拒绝。
`

export const DOC_INSPECT = `# inspect

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
    176-177 uid       178-179 euid            180-181 gid
    182-183 egid      184-185 frame bit 6     186-187 frame bit 7

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
`

export const DOC_INSPECT_ZH = `# inspect

这里的每一层抽象背后都是真实字节。物理内存是一块 64 KiB 的数组，256 帧
乘 256 字节，页表项就是它的下标；磁盘镜像是一个块数组，第一块是超级块。

## 在 shell 里

    hexdump file            dump 一个普通文件的字节
    objdump prog            反汇编 CRX 可执行文件
    mem                     各进程的帧占用
    ps                      进程表

## 进程表就在内存条里

帧 0 是引导记录，帧 1 到 12 是进程表：16 个槽位，每个 192 字节。

    0     占用标志      1     状态         2-3   pid
    4-5   ppid         6-7   pc           8-9   sp
    12-13 退出码       14-17 保留         18-19 等待对象
    20    等待 stdin   21    页数         22    cwd 设备
    23    cwd inode    24-39 页表         40    fd 数
    41-88 fd 表        89-105 名字        106-127 命令行
    128-143 r0-r7      144-145 标志位     146   停机标志
    147-154 cpu tick   155-162 唤醒截止值    163  睡眠模式
    176-177 uid       178-179 euid           180-181 gid
    182-183 egid      184-185 帧号 bit6      186-187 帧号 bit7

tick 计数在 PCB 中占 64 位。睡眠模式 1 保存 Guest tick 截止值，因此 MAX 会
缩短 sleep(ticks)；模式 2 保存单调时钟毫秒截止值，由 sleep_seconds() 使用，
所以 sleep 命令在任何 CPU 速度下都按真实秒数等待。

内核不保留第二份副本。ps 读的就是这些字节，进程面板读的也是。

注意 cwd 的存法：两个字节，一个设备号加一个 inode 号。路径文本是按需沿着
盘上的 parent 链回溯出来的，真实内核用 dentry 指针做的也是同一件事。

寄存器同样不是 JS 变量。CPU 状态只是 PCB 第 128 到 146 字节的一组访问器，
每条指令都在读写那片物理寄存器区。MMU 也一样，每次取指现取帧号：低 6 位
在第 24 到 39 字节，bit6 和 bit7 是 184、186 两个掩码里对应的那一位。帧
位图是第 0 帧最后 32 字节。

## 在面板里

内存面板把帧位图、MMU 翻译器和某一帧的字节放在一起。输入虚拟地址，点结果
旁边的按钮，就会 dump 它映射到的那一帧，并高亮目标字节。每个进程有自己的
色调，灰色是内核，描边的格子是空闲帧。

存储面板对磁盘做同样的事。选设备、点块，或者在 inode 树里选中一个文件：
它的数据块会在块地图上被圈出，它的块指针会变成可以跳转到字节的按钮。

## 你会看到什么

代码页里装着被加载进来的 CRX 映像。栈页开头是加载器写入的 argv 向量。
被释放的帧会在下次分配时清零，所以新页面绝不会泄漏上一个租户的数据。
`

export const DOC_SCRIPT = `# script

A file becomes a program in two ways: assemble it into CRX machine code,
or give it a #! interpreter line and set the execute bit. This is exactly
what execve does on a real system.

## Writing one

    cat > hello.sh
    #!/bin/sh
    echo hello from a script
    ls -l /bin
    <Ctrl-D>

    chmod +x hello.sh
    ./hello.sh

## How it works

cat with no argument reads standard input. The shell has redirected fd 1
into the new file, so your keystrokes land on the disk. Ctrl-D closes the
stream. chmod +x sets the execute bit; u/o/a and rwxst change the rest.

When you run ./hello.sh the kernel reads the first line, finds #!/bin/sh,
and spawns /bin/sh with the script path as argv[0]. The shell, itself CRX
machine code, then reads the file one byte at a time and executes each
line through the same parser the prompt uses.

Without the execute bit exec fails with EACCES; without a #! line and
without the CRX magic it fails with ENOEXEC.

## What the shell understands

    cmd arg ...      run a program found on PATH
    cmd > file       redirect standard output
    cmd &            run in the background
    cd dir           change directory
    exit             leave the shell; init starts a new one
    # comment        ignored

Scripts may live on the removable disk as well. For real machine code
instead of an interpreted script, see man asm.
`

export const DOC_SCRIPT_ZH = `# script

让一个文件变成程序有两条路：把它汇编成 CRX 机器码，或者给它加一行 #!
解释器声明并置上执行位。真实系统里的 execve 做的就是这件事。

## 动手写一个

    cat > hello.sh
    #!/bin/sh
    echo hello from a script
    ls -l /bin
    <Ctrl-D>

    chmod +x hello.sh
    ./hello.sh

## 原理

不带参数的 cat 读标准输入。shell 已经把 fd 1 重定向进了新文件，所以你的
击键会落到磁盘上。Ctrl-D 关闭输入流。chmod +x 置执行位，rwxst 改其余位。

运行 ./hello.sh 时，内核读取首行，发现 #!/bin/sh，于是启动 /bin/sh 并把
脚本路径作为 argv[0] 传入。而 shell 本身也是 CRX 机器码，它会逐字节读取
该文件，用与交互提示符完全相同的解析器执行每一行。

没有执行位，exec 返回 EACCES；既没有 #! 行、也没有 CRX 魔数，返回 ENOEXEC。

## shell 认识的语法

    cmd arg ...      运行 PATH 上找到的程序
    cmd > file       重定向标准输出
    cmd &            后台运行
    cd dir           切换目录
    exit             退出 shell，init 会拉起一个新的
    # 注释           忽略

脚本也可以放在可移动盘上。如果想要真正的机器码而不是解释执行的脚本，
参见 man asm。
`

export const HELLO_S = `; hello.s — assemble with: as hello.s -o hello
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

export const COUNT_S = `; count.s — a loop, a syscall and a sleep
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

export const PAGE_S = `; page.s — ask the CRX kernel allocator for virtual page 8
; build: as page.s -o page      run: ./page
.text
_start:
    mov r0, 29          ; page_alloc(vpn)
    mov r1, 8
    sys
    cmp r0, 65535
    je failed

    mov r4, r0          ; returned virtual address
    mov r5, 65          ; 'A'
    stb [r4+0], r5
    mov r5, 10
    stb [r4+1], r5

    mov r0, 1
    mov r1, 1
    mov r2, r4
    mov r3, 2
    sys

    mov r0, 31          ; page_free(vpn)
    mov r1, 8
    sys
    mov r1, 0
    hlt

failed:
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt

.data
err:
    .asciz "page_alloc failed\\n"
`

export const BLOCK_S = `; block.s — read the sda superblock through the CRX MMIO driver
; build: as block.s -o block      run: ./block      output: CRFS
.text
_start:
    mov r0, 29          ; page_alloc(vpn 8)
    mov r1, 8
    sys
    cmp r0, 65535
    je failed
    mov r4, r0          ; DMA buffer virtual address

    mov r0, 32          ; block_read(device, block, buffer)
    mov r1, 1           ; device 1 = sda
    mov r2, 0           ; superblock
    mov r3, r4
    sys
    cmp r0, 65535
    je failed

    mov r0, 1
    mov r1, 1
    mov r2, r4
    mov r3, 4           ; CRFS magic
    sys
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys

    mov r0, 31
    mov r1, 8
    sys
    mov r1, 0
    hlt

failed:
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt

.data
nl:  .ascii "\\n"
err: .asciz "block read failed\\n"
`
