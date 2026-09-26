# script

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
