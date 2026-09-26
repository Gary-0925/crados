# asm

/bin 里的程序并不特殊：它只是一个头四字节为魔数 \x7fCRX、并且置了执行位的
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
