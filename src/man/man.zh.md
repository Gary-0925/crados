# man

每一页手册就是一个纯文本文件，全部放在 /usr/man 里，这个目录只放手册。
`man 页名` 打开 页名.md；`man 页名.zh` 打开 页名.zh.md。不带参数时
man 打印这份目录。

## 页列表

    README        这个系统是什么、上手步骤、实验
    asm           CRX 指令集、汇编器、系统调用
    storage       磁盘、盘上格式、回写
    inspect       内存、进程表、寄存器
    script        shell 脚本与 #! 机制
    man           本目录

## 在别处阅读

手册页就是普通文件，所以 cat、cp 到可移动盘、hexdump 都对它有效。
宿主侧把所有页面放在同一个文件夹里，上电时安装进 /usr/man。
