# storage

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
                      只有属主或 root 能改。非 root 不能置 setuid。
    偏移 2    size    16 位字节长度
    偏移 4    parent  所在目录的 inode 号
    偏移 6    driver  设备号
    偏移 8    ptr[20] 二十个直接块指针

属主 uid 在超级块里，字节 32 起每个 inode 一个大端 u16。登录 shell 是
uid 1。uid 0 跳过检查。/bin 和普通系统目录一样属 root：非 root 用户
不能在其中新建、删除或改写任何条目——拦住它的是属主检查，不是什么固件
标志。block_read 和 block_write 都需要 euid 0。进程创建的文件属主就是
它的 euid。/home/user 和 /usr/bin 带 sticky，用户删不掉 root 的文件。
mv 要同时有源目录和目标目录的写权限。普通文件的模式是自身标志与所在
目录标志的交集，不能给出目录没有的位。PATH 先搜 /bin 再搜 /usr/bin，
所以 /usr/bin 里的程序不能盖住 ls。

ls -l 显示每一项的模式、属主、大小和名字。属主就取自这张 uid 表：uid 0
显示为 root，uid 1 显示为 user，其他 uid 直接显示数字。这一行由
readview 第 8 类给出，所以 ls 只需要沿途目录的搜索权，不需要文件的读权限。

ls 用到的两个调用 getdents 和 readview 第 8 类，全部由 CRX 内核完成。它的
只读 VFS 能在任意设备上解析 inode 和目录块，经 KCB 0x00C0 的挂载表跨越
挂载点。ps、mem、help、lsblk、df、dmesg 和 hexdump 都由这个内核排版。
objdump 自己检查路径，再请宿主解码指令。

    -rwxr-x-- root    464 cat
    drwxrwx-t root      0 tmp/

## 文件的起止是怎么标记的

块指针给出文件占用了哪些块，它们不要求相邻；size 字段给出最后一块用到第
几字节。既不内联存储，也不使用结束符：范围由指针表决定，末端由 size 决定。
因此单个文件上限为 20 块，256 B 的盘上是 5120 字节。

没有间接块。超出上限会返回 EFBIG，真实文件系统在寻址深度用尽时也是如此。

目录也是普通文件，其数据是一串 16 字节记录，每条含 2 字节 inode 号和
14 字节名字。删除一个名字就是重写这段数据。

## 设备

    /dev/sda   系统盘，2048 块 x 256 B（512 KiB），挂载于 /
    /dev/sdb   第一个导入或新建的磁盘，容量与 sda 相同
    /dev/sdc   下一个，以此类推

开机时只有 sda，根目录树和已安装的程序都在上面。导入镜像或新建空盘会
占用下一个空闲名字，每一个都是独立设备。

## 挂载

    lsblk                    列出块设备
    df                       各文件系统用量
    mount /dev/sdb /mnt      把设备接入目录树
    cp /usr/man/README.md /mnt/   复制文件到该设备
    umount /mnt              摘除

任何设备都可以挂到任意目录，也可以同时挂载多个。把第二个设备挂到
/bin 或 / 上会被上述检查拒绝。

拔盘前先 umount；设备忙时内核会返回 EBUSY。写满返回 ENOSPC。跨设备的
rename 返回 EXDEV，因为 rename 只改写目录项，跨设备请用 cp。

## 回写

没有 sync 命令。内核维护脏标志，大约每秒把被修改的设备写回浏览器存储，
umount、内核恐慌和关闭页面时也会强制写回。存储面板会显示当前状态是否
已经落盘。sync(2) 作为 17 号调用仍然保留。

## 与宿主交换

存储面板可以把当前选中的设备保存为 <设备名>.img，那是整盘逐字节的副本，
超级块在最前，所以 sda 导出为 sda.img。导入镜像不会覆盖任何设备，而是
挂到下一个空闲名字上。盘上格式不匹配的镜像会被拒绝。
