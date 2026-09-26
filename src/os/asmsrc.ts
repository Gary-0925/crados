// 以机器码实现的系统命令：引导时汇编成 CRX 映像烧进 ROM
// execve 后由 CPU 从内存逐条取指执行，与用户自己汇编的二进制走同一条路径
//
// 入口约定  r1 = argc，r2 = argv 块基地址（各参数以 NUL 分隔）
// 系统调用  r0 = 调用号，r1..r3 = 参数，r0 = 返回值
//    1 write(fd,buf,len)   2 read(fd,buf,max)    3 exit(st)     4 open(path,mode)
//    5 close(fd)           6 sleep(ticks)        7 getpid()     8 gethz()
//    9 spawn(path)        10 wait(pid)          11 getdents(path,buf,max)
//   12 getcwd(buf)        13 unlink(path)       14 mkdir(path)
//   15 chmod(path,set,clr) 16 rename(a,b)        17 sync()       18 getenv(key,buf)
//   20 mount(dev,dir)     21 umount(target)     22 kill(pid,sig)
//   35 getuid → r0 uid, r1 euid   36 ttyecho(on)  38 spawnas(path,uid)
//   39 chown(path,uid)
import { OS_VERSION } from '../utils/config'


// 取 argv 中第 n 个参数的地址：入口 r5 = argv 基址, r6 = n，出口 r5 指向该参数
const ARGN = `
argn:
    cmp r6, 0
    je argn_done
argn_scan:
    ldb r7, [r5+0]
    cmp r7, 0
    je argn_next
    add r5, 1
    jmp argn_scan
argn_next:
    add r5, 1
    sub r6, 1
    jmp argn
argn_done:
    ret
`

// 十进制输出：入口 r4 = 数值，破坏 r0-r7
const PRINTNUM = `
printnum:
    mov r5, 0
    mov r6, 0
    cmp r4, 0
    jne pn_conv
    mov r7, 48
    stb [r6+numbuf], r7
    mov r5, 1
    jmp pn_emit
pn_conv:
    mov r6, 5
pn_back:
    cmp r4, 0
    je pn_shift
    mov r7, r4
    mod r7, 10
    add r7, 48
    stb [r6+numbuf], r7
    div r4, 10
    sub r6, 1
    add r5, 1
    jmp pn_back
pn_shift:
    add r6, 1
pn_emit:
    mov r0, 1
    mov r1, 1
    mov r2, numbuf
    add r2, r6
    mov r3, r5
    sys
    ret
`

// 十进制解析：入口 r5 = 字符串地址，出口 r4 = 数值
const ATOI = `
atoi:
    mov r4, 0
atoi_loop:
    ldb r7, [r5+0]
    cmp r7, 48
    jlt atoi_done
    cmp r7, 57
    jgt atoi_done
    mul r4, 10
    sub r7, 48
    add r4, r7
    add r5, 1
    jmp atoi_loop
atoi_done:
    ret
`

// ---- 账户表 (/etc/passwd) 的通用子程序，各账户命令按需复制进自己的映像 ----

// 读整张表进 acctbuf，NUL 结尾。出口 r0 = 0 / 0xffff
const ACCT_LOAD = `
acct_load:
    mov r0, 4
    mov r1, acctpath
    mov r2, 0
    sys
    cmp r0, 65535
    je al_fail
    mov r4, r0
    mov r5, acctbuf
    mov r6, 0
al_loop:
    mov r0, 2
    mov r1, r4
    mov r2, chunk
    mov r3, 128
    sys
    cmp r0, 0
    je al_close
    cmp r0, 65535
    je al_close
    mov r7, r0
    mov r1, chunk
al_copy:
    cmp r7, 0
    je al_loop
    ldb r0, [r1+0]
    cmp r6, 508
    je al_skip
    stb [r5+0], r0
    add r5, 1
    add r6, 1
al_skip:
    add r1, 1
    sub r7, 1
    jmp al_copy
al_close:
    push r5
    mov r0, 5
    mov r1, r4
    sys
    pop r5
    mov r0, 0
    stb [r5+0], r0
    mov r0, 0
    ret
al_fail:
    mov r0, 65535
    ret
`

// acct_find: r5 = 要查的账户名。命中写 f_uid / f_hash / f_perms / f_line。
// 出口 r0 = 0 / 0xffff。破坏 r1-r7。
const ACCT_FIND = `
acct_find:
    mov r0, 0
    stw [r0+find_tgt], r5
    call acct_load
    cmp r0, 0
    jne af_fail
    mov r5, acctbuf
af_line:
    ldb r7, [r5+0]
    cmp r7, 0
    je af_fail
    mov r6, r5
    mov r0, 0
    ldw r1, [r0+find_tgt]
    mov r2, r5
af_cmp:
    ldb r3, [r1+0]
    ldb r4, [r2+0]
    cmp r3, 0
    je af_name_end
    cmp r3, r4
    jne af_next
    add r1, 1
    add r2, 1
    jmp af_cmp
af_name_end:
    cmp r4, 58
    jne af_next
    add r2, 1
    mov r3, 0
af_uid:
    ldb r4, [r2+0]
    cmp r4, 58
    je af_uid_done
    cmp r4, 48
    jlt af_next
    cmp r4, 57
    jgt af_next
    mul r3, 10
    sub r4, 48
    add r3, r4
    add r2, 1
    jmp af_uid
af_uid_done:
    add r2, 1
    mov r0, 0
    stw [r0+f_uid], r3
    stw [r0+f_hash], r2
    stw [r0+f_line], r6
af_skip_hash:
    ldb r4, [r2+0]
    cmp r4, 58
    je af_perms
    cmp r4, 0
    je af_next
    cmp r4, 10
    je af_next
    add r2, 1
    jmp af_skip_hash
af_perms:
    add r2, 1
    stw [r0+f_perms], r2
    mov r0, 0
    ret
af_next:
    mov r5, r6
af_skip_line:
    ldb r7, [r5+0]
    cmp r7, 0
    je af_fail
    cmp r7, 10
    je af_next_line
    add r5, 1
    jmp af_skip_line
af_next_line:
    add r5, 1
    jmp af_line
af_fail:
    mov r0, 65535
    ret
`

// hash_pass: r1 = 密码（NUL 结尾），16 位 djb2 写进 hashval
const HASH_PASS = `
hash_pass:
    mov r7, 5381
hp_loop:
    ldb r3, [r1+0]
    cmp r3, 0
    je hp_done
    mov r4, r7
    mul r4, 33
    xor r4, r3
    mov r7, r4
    add r1, 1
    jmp hp_loop
hp_done:
    mov r4, 0
    stw [r4+hashval], r7
    ret
`

// line_copy: r1 = 源行首, r2 = 目标。整行连换行一起拷，返回时
// r1 = 下一行行首, r2 = 目标新末尾
const LINE_COPY = `
line_copy:
    ldb r7, [r1+0]
    cmp r7, 0
    je lc_done
    stb [r2+0], r7
    cmp r7, 10
    je lc_nl
    add r1, 1
    add r2, 1
    jmp line_copy
lc_nl:
    add r1, 1
    add r2, 1
lc_done:
    ret
`

// acct_write: r1 = NUL 结尾的新表，覆写 /etc/passwd。出口 r0 = 0 / 0xffff
const ACCT_WRITE = `
acct_write:
    mov r4, 0
    stw [r4+aw_src], r1
    mov r0, 4
    mov r1, acctpath
    mov r2, 1
    sys
    cmp r0, 65535
    je aw_fail
    mov r4, r0
    mov r0, 0
    ldw r5, [r0+aw_src]
aw_loop:
    mov r6, 0
    mov r1, r5
aw_count:
    ldb r7, [r1+0]
    cmp r7, 0
    je aw_write
    cmp r6, 128
    je aw_write
    add r1, 1
    add r6, 1
    jmp aw_count
aw_write:
    cmp r6, 0
    je aw_close
    mov r0, 1
    mov r1, r4
    mov r2, r5
    mov r3, r6
    sys
    cmp r0, 65535
    je aw_bad
    add r5, r6
    jmp aw_loop
aw_close:
    mov r0, 5
    mov r1, r4
    sys
    mov r0, 0
    ret
aw_bad:
    push r4
    mov r0, 5
    mov r1, r4
    sys
    pop r4
aw_fail:
    mov r0, 65535
    ret
`

// mem_itoa: r4 = 数值, r5 = 目标。写十进制加 NUL，返回时 r5 指向 NUL
const MEM_ITOA = `
mem_itoa:
    mov r0, 0
    mov r6, 5
    mov r3, 0
    cmp r4, 0
    jne mi_conv
    mov r7, 48
    stb [r6+mi_buf], r7
    mov r3, 1
    jmp mi_emit
mi_conv:
    mov r7, r4
    mod r7, 10
    add r7, 48
    stb [r6+mi_buf], r7
    div r4, 10
    sub r6, 1
    add r3, 1
    cmp r4, 0
    jne mi_conv
    add r6, 1
mi_emit:
    mov r1, r6
mi_copy:
    cmp r3, 0
    je mi_nul
    ldb r7, [r1+mi_buf]
    stb [r5+0], r7
    add r1, 1
    add r5, 1
    sub r3, 1
    jmp mi_copy
mi_nul:
    mov r7, 0
    stb [r5+0], r7
    ret
`

// 账户命令共用的 .data
const ACCT_DATA = `
acctpath:
    .asciz "/etc/passwd"
acctbuf:
    .space 512
chunk:
    .space 128
find_tgt:
    .word 0
f_uid:
    .word 0
f_hash:
    .word 0
f_perms:
    .word 0
f_line:
    .word 0
hashval:
    .word 0
aw_src:
    .word 0
mi_buf:
    .space 6
`

// 单参数系统调用封装：用于 mkdir / rm / sync 一类命令
const oneArg = (name: string, call: number, usage: string, errmsg: string) => `; ${name}
.text
_start:
    cmp r1, 0
    je usage
    mov r4, r1          ; argc
    mov r5, r2          ; cursor
    mov r6, 0
each:
    mov r0, ${call}
    mov r1, r5
    sys
    cmp r0, 65535
    je failed
next:
    ldb r7, [r5+0]
    cmp r7, 0
    je advance
    add r5, 1
    jmp next
advance:
    add r5, 1
    add r6, 1
    cmp r6, r4
    jlt each
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt

.data
err:
    .asciz "${errmsg}\\n"
use:
    .asciz "usage: ${usage}\\n"
`

// Text views are kernel pseudo-files exposed through syscall 26. The executable
// is still real CRX machine code; the kernel only supplies the same bytes that
// /proc and /sys files supply to Unix utilities.
const viewProgram = (name: string, kind: number, takesArg = false) => `; ${name} — read a kernel pseudo-file
.text
_start:
    mov r4, 0
${takesArg ? `    cmp r1, 0
    je usage
    mov r4, r2
` : ''}    mov r0, 26
    mov r1, ${kind}
    mov r2, r4
    mov r3, buf
    sys
    cmp r0, 65535
    je failed
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, buf
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
${takesArg ? `usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
` : ''}.data
buf:
    .space 1200
err:
    .asciz "${name}: operation failed\\n"
${takesArg ? `use:
    .asciz "usage: ${name} file\\n"
` : ''}`

export const ASM_PROGRAMS: Record<string, string> = {
  init: `; init — pid 1, starts the login program and reaps every orphan
.text
_start:
    mov r0, 9
    mov r1, loginpath
    sys
    mov r4, r0          ; login pid
loop:
    mov r0, 10          ; wait for any child
    mov r1, 65535
    sys
    cmp r0, r4
    jne loop
    mov r0, 9           ; login exited, start a new one
    mov r1, loginpath
    sys
    mov r4, r0
    jmp loop

.data
loginpath:
    .asciz "/bin/login"
`,

  sh: `; sh — command parsing, redirection, background jobs and waitpid in userspace
.text
_start:
    mov r4, r1          ; preserve entry argc/argv across getpid
    mov r5, r2
    mov r0, 7
    sys
    mov r7, 0
    stw [r7+selfpid], r0
    mov r1, r0
    mov r0, 28
    sys
    mov r0, 18          ; prompt prefix = getenv("USER") + "@crados:"
    mov r1, userkey
    mov r2, prebuf
    sys
    cmp r0, 0
    jgt pre_scan
    mov r1, defuser
    mov r2, prebuf
pre_def:
    ldb r7, [r1+0]
    stb [r2+0], r7
    cmp r7, 0
    je pre_scan
    add r1, 1
    add r2, 1
    jmp pre_def
pre_scan:
    mov r6, prebuf
pre_scan_loop:
    ldb r7, [r6+0]
    cmp r7, 0
    je pre_fill
    add r6, 1
    jmp pre_scan_loop
pre_fill:
    mov r1, pretail
pre_fill_loop:
    ldb r7, [r1+0]
    stb [r6+0], r7
    cmp r7, 0
    je pre_built
    add r6, 1
    add r1, 1
    jmp pre_fill_loop
pre_built:
    cmp r4, 0
    jgt script_start
    mov r0, 1
    mov r1, 1
    mov r2, banner
    mov r3, 0
    sys
    jmp prompt
script_start:
    mov r0, 4
    mov r1, r5          ; argv[0] is the script path
    mov r2, 0
    sys
    cmp r0, 65535
    je script_fail
    mov r7, 0
    stw [r7+scriptfd], r0
    mov r0, 0
    mov r7, 1
    stb [r0+scriptmode], r7
prompt:
    mov r0, 0
    ldb r7, [r0+scriptmode]
    cmp r7, 0
    jne script_read
    mov r0, 1
    mov r1, 1
    mov r2, prebuf
    mov r3, 0
    sys
    mov r0, 12
    mov r1, cwd
    sys
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, cwd
    sys
    mov r0, 1
    mov r1, 1
    mov r2, post
    mov r3, 0
    sys
    mov r0, 2
    mov r1, 0
    mov r2, line
    mov r3, 190
    sys
    cmp r0, 65535
    je logout
    cmp r0, 0
    je prompt
    jmp parse_init

script_read:
    mov r4, line
    mov r6, 0
script_byte:
    mov r0, 0
    ldw r1, [r0+scriptfd]
    mov r0, 2
    mov r2, onebyte
    mov r3, 1
    sys
    cmp r0, 0
    je script_eof
    ldb r7, [r2+0]
    cmp r7, 10
    je script_line
    stb [r4+0], r7
    add r4, 1
    add r6, 1
    cmp r6, 189
    jlt script_byte
script_line:
    mov r7, 0
    stb [r4+0], r7
    cmp r6, 0
    je prompt
    jmp parse_init
script_eof:
    cmp r6, 0
    jne script_line
    mov r1, 0
    hlt
script_fail:
    mov r0, 1
    mov r1, 2
    mov r2, sfail
    mov r3, 0
    sys
    mov r1, 127
    hlt

parse_init:
    mov r0, 0
    mov r7, 0
    stb [r0+argc], r7
    stb [r0+cmdset], r7
    stb [r0+bg], r7
    stb [r0+redir], r7
    mov r4, line
    mov r6, argbuf
parse:
    ldb r7, [r4+0]
    cmp r7, 32
    jne token
    add r4, 1
    jmp parse
token:
    cmp r7, 0
    je execute
    cmp r7, 62          ; > output redirection
    je parse_redir
    cmp r7, 38          ; & background marker
    je parse_bg
    mov r0, 0
    ldb r3, [r0+cmdset]
    cmp r3, 0
    je command_token
    mov r5, r6
    ldb r3, [r0+argc]
    add r3, 1
    stb [r0+argc], r3
    mov r3, 1          ; this token lives in argbuf
    jmp copy_token
command_token:
    mov r5, cmdbuf
    mov r7, 1
    stb [r0+cmdset], r7
    mov r3, 0          ; command token must not advance argbuf
copy_token:
    ldb r7, [r4+0]
    cmp r7, 0
    je token_end_eol
    cmp r7, 32
    je token_end
    stb [r5+0], r7
    add r4, 1
    add r5, 1
    jmp copy_token
token_end:
    mov r7, 0
    stb [r5+0], r7
    cmp r3, 0
    je token_no_advance
    mov r6, r5
    add r6, 1
token_no_advance:
    add r4, 1
    jmp parse
token_end_eol:
    mov r7, 0
    stb [r5+0], r7
    cmp r3, 0
    je execute
    mov r6, r5
    add r6, 1
    jmp execute

parse_redir:
    add r4, 1
redir_skip:
    ldb r7, [r4+0]
    cmp r7, 32
    jne redir_copy_start
    add r4, 1
    jmp redir_skip
redir_copy_start:
    mov r5, redir
redir_copy:
    ldb r7, [r4+0]
    cmp r7, 0
    je redir_done_eol
    cmp r7, 32
    je redir_done
    stb [r5+0], r7
    add r4, 1
    add r5, 1
    jmp redir_copy
redir_done:
    mov r7, 0
    stb [r5+0], r7
    add r4, 1
    jmp parse
redir_done_eol:
    mov r7, 0
    stb [r5+0], r7
    jmp execute
parse_bg:
    mov r0, 0
    mov r7, 1
    stb [r0+bg], r7
    add r4, 1
    jmp parse

execute:
    mov r0, 0
    ldb r7, [r0+cmdset]
    cmp r7, 0
    je prompt
    mov r4, cmdbuf
    ldb r5, [r4+0]
    cmp r5, 35          ; shell comment
    je prompt
    cmp r5, 101         ; exit
    je try_exit
    cmp r5, 99          ; cd
    je try_cd
    jmp external
try_exit:
    ldb r5, [r4+1]
    cmp r5, 120
    jne external
    jmp logout
try_cd:
    ldb r5, [r4+1]
    cmp r5, 100
    jne external
    ldb r5, [r4+2]
    cmp r5, 0
    jne external
    mov r0, 0
    ldb r5, [r0+argc]
    cmp r5, 0
    je cdhome
    mov r1, argbuf
    jmp docd
cdhome:
    mov r0, 18          ; cd 不带参数回到 $HOME
    mov r1, homekey
    mov r2, homebuf
    sys
    cmp r0, 0
    jgt cdhome_env
    mov r1, homeroot
    jmp docd
cdhome_env:
    mov r1, homebuf
docd:
    mov r0, 23
    sys
    jmp prompt

external:
    mov r0, 0
    ldb r5, [r0+redir]
    cmp r5, 0
    je spawn
    mov r0, 4
    mov r1, redir
    mov r2, 1
    sys
    cmp r0, 65535       ; 已存在查写权限，不存在查创建权限，失败一律报错
    je redirfail
    mov r4, r0          ; output fd
    mov r0, 24          ; saved = dup(1)
    mov r1, 1
    sys
    mov r5, r0
    mov r0, 25          ; dup2(output, 1)
    mov r1, r4
    mov r2, 1
    sys
    mov r0, 5
    mov r1, r4
    sys
spawn:
    mov r0, 0
    ldb r3, [r0+argc]
    mov r0, 9
    mov r1, cmdbuf
    mov r2, argbuf
    mov r6, 0
    ldb r3, [r6+argc]   ; spawn(path, argv, argc): reload after redirection syscalls
    sys
    mov r4, r0          ; child pid
    mov r0, 0
    ldb r7, [r0+redir]
    cmp r7, 0
    je spawned
    mov r0, 25          ; restore stdout
    mov r1, r5
    mov r2, 1
    sys
    mov r0, 5
    mov r1, r5
    sys
spawned:
    cmp r4, 65535
    je notfound
    mov r0, 0
    ldb r7, [r0+bg]
    cmp r7, 0
    jne background
    mov r0, 28
    mov r1, r4
    sys
    mov r0, 10
    mov r1, r4
    sys
    mov r0, 0
    ldw r1, [r0+selfpid]
    mov r0, 28
    sys
    jmp prompt
background:
    mov r0, 1
    mov r1, 1
    mov r2, bgmsg
    mov r3, 0
    sys
    jmp prompt
notfound:
    mov r0, 1
    mov r1, 2
    mov r2, nf
    mov r3, 0
    sys
    jmp prompt
logout:
    mov r0, 1
    mov r1, 1
    mov r2, bye
    mov r3, 0
    sys
    mov r1, 0
    hlt

redirfail:
    mov r0, 1
    mov r1, 2
    mov r2, rfail
    mov r3, 0
    sys
    mov r1, 1
    hlt

.data
line:   .space 192
onebyte: .byte 0
cmdbuf: .space 32
argbuf: .space 128
redir:  .space 48
cwd:    .space 72
argc:   .byte 0
cmdset: .byte 0
bg:     .byte 0
scriptmode: .byte 0
scriptfd: .word 0
selfpid: .word 0
banner: .asciz "crados ${OS_VERSION}\\nType help for commands.\\n"
prebuf: .space 32
userkey: .asciz "USER"
homekey: .asciz "HOME"
homebuf: .space 64
pretail: .asciz "@crados:"
defuser: .asciz "root"
post:   .asciz "$ "
homeroot: .asciz "/"
bgmsg:  .asciz "[background]\\n"
nf:     .asciz "sh: command not found\\n"
bye:    .asciz "logout\\n"
sfail:  .asciz "sh: cannot open script\\n"
rfail:  .asciz "sh: cannot open redirection target\\n"
`,

  cat: `; cat — with an argument copy that file, without one copy standard input
.text
_start:
    cmp r1, 0
    je stdin_mode
    mov r0, 4           ; open(path, O_RDONLY)
    mov r1, r2
    mov r2, 0
    sys
    cmp r0, 65535
    je failed
    mov r4, r0
floop:
    mov r0, 2           ; read(fd, buf, 192)
    mov r1, r4
    mov r2, buf
    mov r3, 192
    sys
    cmp r0, 0
    je fdone
    cmp r0, 65535
    je fdone
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, buf
    sys
    jmp floop
fdone:
    mov r0, 5
    mov r1, r4
    sys
    mov r1, 0
    hlt

; reading the console yields one line at a time; 0xffff means Ctrl-D
stdin_mode:
    mov r0, 2
    mov r1, 0
    mov r2, buf
    mov r3, 192
    sys
    cmp r0, 65535
    je sdone
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, buf
    sys
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    jmp stdin_mode
sdone:
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
buf:
    .space 200
nl:
    .ascii "\\n"
err:
    .asciz "cat: cannot open file\\n"
`,

  ls: `; ls — list a directory through getdents(2), syscall 11
; -l asks readview(2) kind 8 (syscall 26) for mode, owner, size and name per entry.
; Both are served by the CRX kernel (sys_getdents, sys_view); nothing reaches TypeScript.
.text
_start:
    mov r4, dot
    mov r3, 0           ; set once a path argument has been taken
    mov r5, r2
    mov r6, r1
scan:
    cmp r6, 0
    je fetch
    ldb r7, [r5+0]
    cmp r7, 45
    je optword
    cmp r3, 0
    jne skipword
    mov r4, r5          ; the first non-option word is the path
    mov r3, 1
    jmp skipword
optword:
    add r5, 1
    ldb r7, [r5+0]
    cmp r7, 0
    je skipped
    cmp r7, 108         ; 'l'
    jne optword
    mov r0, lflag
    mov r7, 1
    stb [r0+0], r7
    jmp optword
skipword:
    ldb r7, [r5+0]
    cmp r7, 0
    je skipped
    add r5, 1
    jmp skipword
skipped:
    add r5, 1
    sub r6, 1
    jmp scan
fetch:
    mov r0, 11
    mov r1, r4
    mov r2, buf
    mov r3, 48
    sys
    cmp r0, 65535
    je notdir
    mov r5, r0
    mov r6, 0
    mov r7, buf
    mov r0, lflag
    ldb r0, [r0+0]
    cmp r0, 0
    jne longlist
each:
    cmp r6, r5
    je done
    mov r0, 1
    mov r1, 1
    mov r2, r7
    mov r3, 0
    sys
    mov r0, 1
    mov r1, 1
    mov r2, gap
    mov r3, 2
    sys
    add r7, 16
    add r6, 1
    jmp each
done:
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r1, 0
    hlt

; ls -l: build "dir/name" for every record and ask the kernel for its line
longlist:
    cmp r6, r5
    je lldone
    mov r1, pbuf
    mov r2, r4
    mov r3, 0           ; last byte copied
cpdir:
    ldb r0, [r2+0]
    cmp r0, 0
    je dirend
    stb [r1+0], r0
    mov r3, r0
    add r1, 1
    add r2, 1
    jmp cpdir
dirend:
    cmp r3, 47          ; already ends in '/'
    je cpname
    mov r0, 47
    stb [r1+0], r0
    add r1, 1
cpname:
    mov r2, r7
cpnext:
    ldb r0, [r2+0]
    stb [r1+0], r0
    cmp r0, 0
    je built
    add r1, 1
    add r2, 1
    jmp cpnext
built:
    mov r1, pbuf
    call statline
    add r7, 16
    add r6, 1
    jmp longlist
lldone:
    mov r1, 0
    hlt

; not a directory: plain ls fails, ls -l describes the file itself
notdir:
    mov r0, lflag
    ldb r0, [r0+0]
    cmp r0, 0
    je failed
    mov r1, r4
    call statline
    mov r1, r0
    hlt

; statline(r1 = path): readview kind 8 prints mode, owner, size, name.
; Returns r0 = 0 on success, 1 on failure.
statline:
    mov r2, r1
    mov r0, 26
    mov r1, 8
    mov r3, line
    sys
    cmp r0, 65535
    je statfail
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, line
    sys
    mov r0, 0
    ret
statfail:
    mov r0, 1
    mov r1, 2
    mov r2, serr
    mov r3, 0
    sys
    mov r0, 1
    ret

failed:
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt

.data
buf:
    .space 768
pbuf:
    .space 96
line:
    .space 64
lflag:
    .byte 0
dot:
    .asciz "."
gap:
    .ascii "  "
nl:
    .ascii "\\n"
err:
    .asciz "ls: cannot read directory\\n"
serr:
    .asciz "ls: cannot access file\\n"
`,

  pwd: `; pwd — print the working directory
.text
_start:
    mov r0, 12
    mov r1, buf
    sys
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, buf
    sys
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r1, 0
    hlt

.data
buf:
    .space 72
nl:
    .ascii "\\n"
`,

  echo: `; echo — write the arguments separated by spaces
.text
_start:
    mov r6, r1
    mov r5, r2
    mov r4, 0
loop:
    cmp r4, r6
    jlt body
    jmp done
body:
    mov r0, 1
    mov r1, 1
    mov r2, r5
    mov r3, 0
    sys
scan:
    ldb r7, [r5+0]
    cmp r7, 0
    je scanned
    add r5, 1
    jmp scan
scanned:
    add r5, 1
    add r4, 1
    cmp r4, r6
    jlt space
    jmp loop
space:
    mov r0, 1
    mov r1, 1
    mov r2, spc
    mov r3, 1
    sys
    jmp loop
done:
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r1, 0
    hlt

.data
spc:
    .ascii " "
nl:
    .ascii "\\n"
`,

  cp: `; cp — copy a file through a 128 byte buffer, one block at a time
.text
_start:
    cmp r1, 2
    jlt usage
    mov r4, r2          ; argv base, also the source path
    mov r5, r2
    mov r6, 1
    call argn           ; r5 = target path
    mov r1, r5
    mov r3, outpath
    mov r6, 0
copy_target:
    ldb r7, [r1+0]
    cmp r7, 0
    je target_copied
    stb [r3+0], r7
    mov r6, r7
    add r1, 1
    add r3, 1
    jmp copy_target
target_copied:
    cmp r6, 47          ; target ending in '/' means append source basename
    jne target_ready
    mov r1, r4
    mov r2, r4
find_base:
    ldb r7, [r1+0]
    cmp r7, 0
    je append_base
    cmp r7, 47
    jne base_next
    mov r2, r1
    add r2, 1
base_next:
    add r1, 1
    jmp find_base
append_base:
    ldb r7, [r2+0]
    stb [r3+0], r7
    cmp r7, 0
    je target_ready
    add r2, 1
    add r3, 1
    jmp append_base
target_ready:
    mov r7, 0
    stb [r3+0], r7
    mov r5, outpath
    push r5
    mov r0, 4           ; open(source, O_RDONLY)
    mov r1, r4
    mov r2, 0
    sys
    cmp r0, 65535
    je failed
    mov r6, r0
    pop r5
    mov r0, 4           ; open(target, O_WRONLY)
    mov r1, r5
    mov r2, 1
    sys
    cmp r0, 65535
    je failed
    mov r7, r0
loop:
    mov r0, 2
    mov r1, r6
    mov r2, buf
    mov r3, 128
    sys
    cmp r0, 0
    je done
    cmp r0, 65535
    je done
    mov r3, r0
    mov r0, 1
    mov r1, r7
    mov r2, buf
    sys
    jmp loop
done:
    mov r0, 5
    mov r1, r6
    sys
    mov r0, 5
    mov r1, r7
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ARGN}
.data
buf:
    .space 136
outpath:
    .space 96
err:
    .asciz "cp: cannot copy file\\n"
use:
    .asciz "usage: cp source target\\n"
`,

  mkdir: oneArg('mkdir', 14, 'mkdir directory...', 'mkdir: cannot create directory'),
  rm: oneArg('rm', 13, 'rm file...', 'rm: cannot remove file'),
  rmdir: oneArg('rmdir', 13, 'rmdir directory...', 'rmdir: cannot remove directory'),
  touch: `; touch — create a file if it does not exist
.text
_start:
    cmp r1, 0
    je usage
    mov r0, 4           ; open(path, O_APPEND) creates on demand
    mov r1, r2
    mov r2, 2
    sys
    cmp r0, 65535
    je failed
    mov r1, r0
    mov r0, 5
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt

.data
err:
    .asciz "touch: cannot create file\\n"
use:
    .asciz "usage: touch file\\n"
`,

  chmod: `; chmod — set or clear mode bits: [u|o|a][+|-][rwxst]
.text
_start:
    cmp r1, 2
    jlt usage
    mov r5, r2
    mov r6, 0
    call argn
    mov r4, r5          ; mode string
    mov r5, r2
    mov r6, 1
    call argn
    mov r6, r5          ; path
    mov r3, 0           ; who: 0 owner, 1 other, 2 both
    ldb r7, [r4+0]
    cmp r7, 117         ; u
    je who_skip
    cmp r7, 111         ; o
    jne who_a
    mov r3, 1
    jmp who_skip
who_a:
    cmp r7, 97          ; a
    jne parse_op
    mov r3, 2
who_skip:
    add r4, 1
parse_op:
    ldb r7, [r4+0]
    mov r2, 0           ; 0 clear, 1 set
    cmp r7, 43          ; +
    je op_set
    cmp r7, 45          ; -
    jne usage
    jmp letters
op_set:
    mov r2, 1
letters:
    add r4, 1
    mov r0, 0           ; mask
    mov r1, 0           ; letter count
letter:
    ldb r7, [r4+0]
    cmp r7, 0
    je letters_done
    add r1, 1
    call letter_bits
    cmp r7, 0
    je usage
    or r0, r7
    add r4, 1
    jmp letter
letters_done:
    cmp r1, 0
    je usage
    cmp r2, 0
    je do_clear
    mov r2, r0
    mov r3, 0
    jmp do_sys
do_clear:
    mov r3, r0
    mov r2, 0
do_sys:
    mov r1, r6
    mov r0, 15
    sys
    cmp r0, 65535
    je failed
    mov r1, 0
    hlt

; r7 = letter, r3 = who. Returns the bit mask in r7, or 0.
letter_bits:
    cmp r7, 120         ; x  shared execute bit
    je bit_x
    cmp r7, 115         ; s
    je bit_s
    cmp r7, 116         ; t
    je bit_t
    cmp r7, 114         ; r
    je bit_r
    cmp r7, 119         ; w
    je bit_w
    mov r7, 0
    ret
bit_x:
    cmp r3, 1
    je bit_ox
    cmp r3, 2
    je bit_ax
    mov r7, 1
    ret
bit_ox:
    mov r7, 128
    ret
bit_ax:
    mov r7, 129
    ret
bit_s:
    mov r7, 32
    ret
bit_t:
    mov r7, 64
    ret
bit_r:
    cmp r3, 1
    je bit_or
    cmp r3, 2
    je bit_ar
    mov r7, 2
    ret
bit_or:
    mov r7, 8
    ret
bit_ar:
    mov r7, 10
    ret
bit_w:
    cmp r3, 1
    je bit_ow
    cmp r3, 2
    je bit_aw
    mov r7, 4
    ret
bit_ow:
    mov r7, 16
    ret
bit_aw:
    mov r7, 20
    ret

failed:
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ARGN}
.data
err:
    .asciz "chmod: cannot change mode\\n"
use:
    .asciz "usage: chmod [u|o|a][+|-][rwxst] file\\n"
`,

  mv: `; mv — rename, which only rewrites a directory entry
.text
_start:
    cmp r1, 2
    jlt usage
    mov r4, r2          ; source
    mov r5, r2
    mov r6, 1
    call argn           ; r5 = target
    mov r0, 16
    mov r1, r4
    mov r2, r5
    sys
    cmp r0, 65535
    je failed
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ARGN}
.data
err:
    .asciz "mv: cannot rename\\n"
use:
    .asciz "usage: mv source target\\n"
`,

  mount: `; mount — attach a block device to a directory
.text
_start:
    cmp r1, 2
    jlt usage
    mov r4, r2
    mov r5, r2
    mov r6, 1
    call argn
    mov r0, 20
    mov r1, r4
    mov r2, r5
    sys
    cmp r0, 65535
    je failed
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ARGN}
.data
err:
    .asciz "mount: cannot mount device\\n"
use:
    .asciz "usage: mount device directory\\n"
`,

  umount: oneArg('umount', 21, 'umount directory', 'umount: cannot unmount'),

  sleep: `; sleep — suspend for the given number of seconds
.text
_start:
    cmp r1, 0
    je usage
    mov r5, r2
    call atoi           ; r4 = seconds
    mov r0, 34          ; real-time sleep in seconds
    mov r1, r4
    sys
    mov r1, 0
    hlt
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ATOI}
.data
use:
    .asciz "usage: sleep seconds\\n"
`,

  kill: `; kill — send SIGTERM to a process
.text
_start:
    cmp r1, 0
    je usage
    mov r5, r2
    call atoi
    mov r0, 22
    mov r1, r4
    mov r2, 15
    sys
    cmp r0, 65535
    je failed
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ATOI}
.data
err:
    .asciz "kill: failed\\n"
use:
    .asciz "usage: kill pid\\n"
`,

  count: `; count — print a counter, sleeping one tick between numbers
.text
_start:
    mov r0, 10
    cmp r1, 0
    je havelimit
    mov r5, r2
    call atoi
    jmp haveparsed
havelimit:
    mov r4, 10
haveparsed:
    stb [r6+limit], r4
    mov r3, 1
loop:
    mov r6, 0           ; printnum clobbers r6, reload the base each round
    ldb r7, [r6+limit]
    cmp r3, r7
    jgt finish
    push r3
    mov r4, r3
    call printnum
    mov r0, 1
    mov r1, 1
    mov r2, spc
    mov r3, 1
    sys
    mov r0, 6
    mov r1, 1
    sys
    pop r3
    add r3, 1
    jmp loop
finish:
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r1, 0
    hlt
${PRINTNUM}
${ATOI}
.data
numbuf:
    .space 8
limit:
    .byte 10
spc:
    .ascii " "
nl:
    .ascii "\\n"
`,

  pid: `; pid — print the process id
.text
_start:
    mov r0, 7
    sys
    mov r4, r0
    call printnum
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r1, 0
    hlt
${PRINTNUM}
.data
numbuf:
    .space 8
nl:
    .ascii "\\n"
`,

  whoami: `; whoami — print the USER environment variable
.text
_start:
    mov r0, 18
    mov r1, key
    mov r2, buf
    sys
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, buf
    sys
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r1, 0
    hlt

.data
key:
    .asciz "USER"
buf:
    .space 32
nl:
    .ascii "\\n"
`,

  uname: `; uname — print the system name, -a prints the long form
.text
_start:
    cmp r1, 0
    jgt long
    mov r0, 1
    mov r1, 1
    mov r2, short_s
    mov r3, 0
    sys
    mov r1, 0
    hlt
long:
    mov r0, 1
    mov r1, 1
    mov r2, long_s
    mov r3, 0
    sys
    mov r1, 0
    hlt

.data
short_s:
    .asciz "crados\\n"
long_s:
    .asciz "crados ${OS_VERSION} browser js single-core\\n"
`,

  clear: `; clear — emit the erase-display control sequence
.text
_start:
    mov r0, 1
    mov r1, 1
    mov r2, esc
    mov r3, 4
    sys
    mov r1, 0
    hlt

.data
esc:
    .byte 27
    .ascii "[2J"
`,

  true: `; true — exit with status 0
.text
_start:
    mov r1, 0
    hlt
`,

  false: `; false — exit with status 1
.text
_start:
    mov r1, 1
    hlt
`,

  head: `; head — copy the first ten lines of a file
.text
_start:
    cmp r1, 0
    je usage
    mov r3, r2
    mov r4, 10
    mov r0, 0
    stw [r0+limit], r4
    ldb r7, [r2+0]
    cmp r7, 45
    jne plain_path
    cmp r1, 3
    jlt usage
    mov r5, r3
    mov r6, 1
    call argn
    call atoi
    mov r0, 0
    stw [r0+limit], r4
    mov r5, r3
    mov r6, 2
    call argn
    mov r4, r5
    jmp open_file
plain_path:
    mov r4, r3
open_file:
    mov r0, 4
    mov r1, r4
    mov r2, 0
    sys
    cmp r0, 65535
    je failed
    mov r4, r0          ; fd
    mov r0, 0
    mov r7, 0
    stw [r0+lines], r7
read:
    mov r0, 2
    mov r1, r4
    mov r2, buf
    mov r3, 128
    sys
    cmp r0, 0
    je done
    mov r6, r0          ; count
    mov r5, buf
scan:
    cmp r6, 0
    je read
    ldb r7, [r5+0]
    mov r0, 1
    mov r1, 1
    mov r2, r5
    mov r3, 1
    sys
    cmp r7, 10
    jne next
    mov r0, 0
    ldw r3, [r0+lines]
    add r3, 1
    stw [r0+lines], r3
    ldw r7, [r0+limit]
    cmp r3, r7
    je done
next:
    add r5, 1
    sub r6, 1
    jmp scan
done:
    mov r0, 5
    mov r1, r4
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ARGN}
${ATOI}
.data
buf: .space 136
lines: .word 0
err: .asciz "head: cannot read file\\n"
use: .asciz "usage: head file\\n"
limit: .word 10
`,

  wc: `; wc — count lines, words and bytes
.text
_start:
    cmp r1, 0
    je usage
    mov r4, r2          ; retain pathname
    mov r0, 4
    mov r1, r4
    mov r2, 0
    sys
    cmp r0, 65535
    je failed
    mov r7, r0          ; fd
    mov r0, 0
    mov r3, 0
    stw [r0+lines], r3
    stw [r0+words], r3
    stw [r0+bytes], r3
    stb [r0+inword], r3
read:
    mov r0, 2
    mov r1, r7
    mov r2, buf
    mov r3, 128
    sys
    cmp r0, 0
    je report
    mov r6, r0
    mov r5, buf
scan:
    cmp r6, 0
    je read
    mov r0, 0
    ldw r3, [r0+bytes]
    add r3, 1
    stw [r0+bytes], r3
    ldb r4, [r5+0]
    cmp r4, 10
    jne notnl
    ldw r3, [r0+lines]
    add r3, 1
    stw [r0+lines], r3
notnl:
    cmp r4, 32
    je whitespace
    cmp r4, 10
    je whitespace
    cmp r4, 9
    je whitespace
    ldb r3, [r0+inword]
    cmp r3, 0
    jne charnext
    mov r3, 1
    stb [r0+inword], r3
    ldw r3, [r0+words]
    add r3, 1
    stw [r0+words], r3
    jmp charnext
whitespace:
    mov r3, 0
    stb [r0+inword], r3
charnext:
    add r5, 1
    sub r6, 1
    jmp scan
report:
    mov r0, 0
    ldw r4, [r0+lines]
    call printnum
    call space
    mov r0, 0
    ldw r4, [r0+words]
    call printnum
    call space
    mov r0, 0
    ldw r4, [r0+bytes]
    call printnum
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r1, 0
    hlt
space:
    mov r0, 1
    mov r1, 1
    mov r2, spc
    mov r3, 1
    sys
    ret
failed:
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${PRINTNUM}
.data
buf: .space 136
lines: .word 0
words: .word 0
bytes: .word 0
inword: .byte 0
numbuf: .space 8
spc: .ascii " "
nl: .ascii "\\n"
err: .asciz "wc: cannot read file\\n"
use: .asciz "usage: wc file\\n"
`,

  ps: viewProgram('ps', 1),
  mem: viewProgram('mem', 2),
  lsblk: viewProgram('lsblk', 3),
  df: viewProgram('df', 4),
  dmesg: viewProgram('dmesg', 5),
  hexdump: viewProgram('hexdump', 6, true),
  objdump: viewProgram('objdump', 7, true),
  // man 直接流式读取 /usr/man/<页>，因此不受内核视图缓冲区大小限制
  man: `; man — stream a manual page out of /usr/man, or list pages with no argument
.text
_start:
    cmp r1, 0
    je catalog
    mov r4, path        ; dest cursor, shared by copystr
    mov r5, dir
    call copystr
    mov r5, r2          ; argv[0] is the page name
    call copystr
    mov r7, 0
    stb [r4+0], r7
    jmp open

catalog:
    mov r0, 1
    mov r1, 1
    mov r2, manlist
    mov r3, 0
    sys
    mov r1, 0
    hlt

open:
    mov r0, 4           ; open(path, O_RDONLY)
    mov r1, path
    mov r2, 0
    sys
    cmp r0, 65535
    je failed
    mov r4, r0
loop:
    mov r0, 2
    mov r1, r4
    mov r2, buf
    mov r3, 192
    sys
    cmp r0, 0
    je done
    cmp r0, 65535
    je done
    mov r3, r0
    mov r0, 1
    mov r1, 1
    mov r2, buf
    sys
    jmp loop
done:
    mov r0, 5
    mov r1, r4
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

copystr:
    ldb r7, [r5+0]
    cmp r7, 0
    je copydone
    stb [r4+0], r7
    add r4, 1
    add r5, 1
    jmp copystr
copydone:
    ret

.data
path:    .space 64
buf:     .space 200
dir:     .asciz "/usr/man/"
err:     .asciz "man: no such page, try man man\\n"
manlist: .asciz "README        what this system is\\nasm           instruction set, assembler, syscalls\\nstorage       disks and the on-disk format\\ninspect       memory, the process table, registers\\nscript        shell scripts and the #! mechanism\\nman           this catalog\\n\\nChinese: append .zh, for example man README.zh\\n"
`,
  help: viewProgram('help', 9),

  as: `; as — machine-code frontend to the kernel's boot assembler service
.text
_start:
    cmp r1, 3
    jlt usage
    mov r4, r2          ; source
    mov r5, r2
    mov r6, 2           ; argv[2] is output in: as src -o output
    call argn
    mov r0, 27
    mov r1, r4
    mov r2, r5
    sys
    cmp r0, 65535
    je failed
    mov r0, 1
    mov r1, 1
    mov r2, ok
    mov r3, 0
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ARGN}
.data
ok: .asciz "assembly complete\\n"
err: .asciz "as: assembly failed\\n"
use: .asciz "usage: as source.s -o output\\n"
`,

  login: `; login — console account authentication; init starts this instead of sh.
; setuid root. No arguments: the console login loop. With an account name:
; authenticate and hand back one shell, which is what su is built on.
.text
_start:
    mov r0, 0
    mov r7, 0
    stb [r0+mode], r7   ; 0 = console loop
    cmp r1, 0
    je ask_name
    mov r7, 1
    stb [r0+mode], r7   ; 1 = one-shot (su)
    mov r5, r2
    jmp target_ready
ask_name:
    mov r0, 1
    mov r1, 1
    mov r2, nprompt
    mov r3, 0
    sys
    mov r0, 2
    mov r1, 0
    mov r2, namebuf
    mov r3, 31
    sys
    cmp r0, 65535
    je retry
    cmp r0, 0
    je ask_name
    mov r5, namebuf
target_ready:
    call acct_find
    cmp r0, 0
    je found
    mov r2, badmsg
    jmp fail
found:
    ; 哈希是 "-"（未设密码）→ 免密码直接登录
    mov r0, 0
    ldw r1, [r0+f_hash]
    ldb r2, [r1+0]
    cmp r2, 45
    jne chk_su
    ldb r2, [r1+1]
    cmp r2, 58
    je do_login
chk_su:
    ; 仅 su 模式：真实 uid 0（root 调 su）免密码。控制台登录进程本身恒为
    ; uid 0，不能套用该豁免，否则任何账户都能免密登录。
    mov r0, 0
    ldb r2, [r0+mode]
    cmp r2, 0
    je need_pass
    mov r0, 35
    sys
    cmp r0, 0
    je do_login
need_pass:
    mov r0, 1
    mov r1, 1
    mov r2, pprompt
    mov r3, 0
    sys
    mov r0, 36
    mov r1, 0
    sys
    mov r0, 2
    mov r1, 0
    mov r2, passbuf
    mov r3, 31
    sys
    push r0
    mov r0, 36
    mov r1, 1
    sys
    pop r0
    cmp r0, 65535
    je retry
    mov r1, passbuf
    call hash_pass
    mov r0, 0
    ldw r5, [r0+f_hash]
    call atoi
    mov r0, 0
    ldw r1, [r0+hashval]
    cmp r4, r1
    je do_login
    mov r2, badmsg
    jmp fail
do_login:
    mov r0, 38
    mov r1, shpath
    mov r2, 0
    ldw r2, [r2+f_uid]
    sys
    cmp r0, 65535
    je spawnfail
    mov r4, r0
    mov r0, 10
    mov r1, r4
    sys
    mov r0, 0
    ldb r7, [r0+mode]
    cmp r7, 0
    je ask_name
    mov r1, 0
    hlt
retry:
    mov r0, 0
    ldb r7, [r0+mode]
    cmp r7, 0
    je ask_name
    mov r1, 1
    hlt
fail:
    mov r0, 1
    mov r1, 2
    mov r3, 0
    sys
    mov r0, 0
    ldb r7, [r0+mode]
    cmp r7, 0
    je ask_name
    mov r1, 1
    hlt
spawnfail:
    mov r0, 1
    mov r1, 2
    mov r2, spfail
    mov r3, 0
    sys
    mov r0, 0
    ldb r7, [r0+mode]
    cmp r7, 0
    je ask_name
    mov r1, 1
    hlt
${ACCT_LOAD}
${ACCT_FIND}
${HASH_PASS}
${ATOI}
.data
${ACCT_DATA}
nprompt:
    .asciz "crados login: "
pprompt:
    .asciz "Password: "
badmsg:
    .asciz "login incorrect\\n"
spfail:
    .asciz "login: cannot start shell\\n"
shpath:
    .asciz "/bin/sh"
namebuf:
    .space 32
passbuf:
    .space 32
mode:
    .byte 0
`,

  su: `; su — switch account; delegates to the setuid login program
.text
_start:
    mov r4, r1
    mov r5, r2
    cmp r4, 0
    jgt su_spawn
    mov r5, rootarg
    mov r4, 1
su_spawn:
    mov r0, 9
    mov r1, lpath
    mov r2, r5
    mov r3, r4
    sys
    cmp r0, 65535
    je failed
    mov r4, r0
    mov r0, 10
    mov r1, r4
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
lpath:
    .asciz "/bin/login"
rootarg:
    .asciz "root"
err:
    .asciz "su: cannot start login\\n"
`,

  users: `; users — list the account table: name, uid, permission letters
.text
_start:
    call acct_load
    cmp r0, 0
    je show
    mov r0, 1
    mov r1, 2
    mov r2, err
    mov r3, 0
    sys
    mov r1, 1
    hlt
show:
    mov r0, 1
    mov r1, 1
    mov r2, hdr
    mov r3, 0
    sys
    mov r5, acctbuf
line:
    ldb r7, [r5+0]
    cmp r7, 0
    je done
    cmp r7, 10
    je skip_empty
    mov r2, r5
n_scan:
    ldb r7, [r2+0]
    cmp r7, 58
    je n_done
    cmp r7, 0
    je done
    cmp r7, 10
    je skip_line
    add r2, 1
    jmp n_scan
n_done:
    mov r3, r2
    sub r3, r5
    push r2
    mov r0, 1
    mov r1, 1
    mov r2, r5
    sys
    pop r2
    add r2, 1       ; 先算出 uid 游标（下面的 sp 写入会占用 r2）
    mov r5, r2
    mov r0, 1
    mov r1, 1
    mov r2, sp
    mov r3, 1
    sys
    call atoi
    push r5
    call printnum
    pop r5
    mov r0, 1
    mov r1, 1
    mov r2, sp
    mov r3, 1
    sys
    add r5, 1
h_scan:
    ldb r7, [r5+0]
    cmp r7, 58
    je h_done
    cmp r7, 0
    je done
    cmp r7, 10
    je skip_line
    add r5, 1
    jmp h_scan
h_done:
    add r5, 1
    mov r2, r5
p_scan:
    ldb r7, [r2+0]
    cmp r7, 10
    je p_emit
    cmp r7, 0
    je p_emit
    add r2, 1
    jmp p_scan
p_emit:
    mov r3, r2
    sub r3, r5
    mov r6, r2
    add r6, 1         ; 下一行行首（write 会占用 r2，先把游标存进 r6）
    cmp r3, 0
    je p_nl
    push r2
    mov r0, 1
    mov r1, 1
    mov r2, r5
    sys
    pop r2
p_nl:
    mov r0, 1
    mov r1, 1
    mov r2, nl
    mov r3, 1
    sys
    mov r5, r6
    jmp line
skip_empty:
    add r5, 1
    jmp line
skip_line:
    mov r5, r2
sl_loop:
    ldb r7, [r5+0]
    cmp r7, 0
    je done
    cmp r7, 10
    je sl_next
    add r5, 1
    jmp sl_loop
sl_next:
    add r5, 1
    jmp line
done:
    mov r1, 0
    hlt
${ACCT_LOAD}
${ATOI}
${PRINTNUM}
.data
${ACCT_DATA}
numbuf:
    .space 6
hdr:
    .asciz "NAME      UID PERMS\\n"
sp:
    .ascii "     "
nl:
    .ascii "\\n"
err:
    .asciz "users: cannot read /etc/passwd\\n"
`,

  passwd: `; passwd — change an account's password. setuid root.
; passwd [name]: real uid 0 may change any account; everyone else only their own.
; With no argument changes $USER. An empty new password clears the password.
.text
_start:
    mov r4, r1
    mov r5, r2
    mov r0, 35
    sys
    mov r6, 0
    stw [r6+ruid], r0
    cmp r4, 0
    jgt have_target
    mov r0, 18
    mov r1, userkey
    mov r2, tgtbuf
    sys
    cmp r0, 0
    jgt target_ready
    mov r0, 1
    mov r1, 2
    mov r2, nouser
    mov r3, 0
    sys
    mov r1, 1
    hlt
have_target:
    ; argv[0] 就是目标账户名（argv 块不含程序名），r5 已指向它
target_ready:
    mov r6, 0
    stw [r6+tgt], r5
    call acct_find
    cmp r0, 0
    je known
    mov r0, 1
    mov r1, 2
    mov r2, nosuch
    mov r3, 0
    sys
    mov r1, 1
    hlt
known:
    mov r6, 0
    ldw r1, [r6+ruid]
    cmp r1, 0
    je ask_new
    ldw r2, [r6+f_uid]
    cmp r1, r2
    je ask_new
    mov r0, 1
    mov r1, 2
    mov r2, deny
    mov r3, 0
    sys
    mov r1, 1
    hlt
ask_new:
    mov r0, 1
    mov r1, 1
    mov r2, np1
    mov r3, 0
    sys
    mov r0, 36
    mov r1, 0
    sys
    mov r0, 2
    mov r1, 0
    mov r2, p1
    mov r3, 31
    sys
    push r0
    mov r0, 36
    mov r1, 1
    sys
    pop r0
    cmp r0, 65535
    je cancelled
    mov r0, 1
    mov r1, 1
    mov r2, np2
    mov r3, 0
    sys
    mov r0, 36
    mov r1, 0
    sys
    mov r0, 2
    mov r1, 0
    mov r2, p2
    mov r3, 31
    sys
    push r0
    mov r0, 36
    mov r1, 1
    sys
    pop r0
    cmp r0, 65535
    je cancelled
    mov r1, p1
    mov r2, p2
cmp_loop:
    ldb r3, [r1+0]
    ldb r4, [r2+0]
    cmp r3, r4
    jne mismatch
    cmp r3, 0
    je match_ok
    add r1, 1
    add r2, 1
    jmp cmp_loop
mismatch:
    mov r0, 1
    mov r1, 2
    mov r2, nomatch
    mov r3, 0
    sys
    mov r1, 1
    hlt
cancelled:
    mov r0, 1
    mov r1, 2
    mov r2, cancel
    mov r3, 0
    sys
    mov r1, 1
    hlt
match_ok:
    mov r1, p1
    ldb r7, [r1+0]
    cmp r7, 0
    jne hash_it
    mov r6, 0
    mov r7, 1
    stb [r6+dash], r7
    jmp build
hash_it:
    mov r6, 0
    mov r7, 0
    stb [r6+dash], r7
    call hash_pass
build:
    ; rebuild the table: lines before the target as-is, the target line with
    ; the new hash field, then the rest
    mov r1, acctbuf
    mov r2, outbuf
    mov r6, 0
    ldw r3, [r6+f_line]
rw_loop:
    cmp r1, r3
    je rw_target
    ldb r7, [r1+0]
    cmp r7, 0
    je rw_done
    call line_copy
    jmp rw_loop
rw_target:
t_name:
    ldb r7, [r1+0]
    stb [r2+0], r7
    add r1, 1
    add r2, 1
    cmp r7, 58
    jne t_name
t_uid:
    ldb r7, [r1+0]
    stb [r2+0], r7
    add r1, 1
    add r2, 1
    cmp r7, 58
    jne t_uid
    mov r6, 0
    ldb r7, [r6+dash]
    cmp r7, 0
    jne t_dash
    ldw r4, [r6+hashval]
    mov r5, r2
    push r1         ; mem_itoa 破坏 r1（acctbuf 游标），必须保护
    call mem_itoa
    pop r1
    mov r2, r5
    jmp t_colon
t_dash:
    mov r7, 45
    stb [r2+0], r7
    add r2, 1
t_colon:
    mov r7, 58
    stb [r2+0], r7
    add r2, 1
t_skip_hash:
    ; 跳过旧哈希；把分隔冒号一并吃掉（t_colon 已经写过冒号了）
    ldb r7, [r1+0]
    cmp r7, 0
    je rw_done
    add r1, 1
    cmp r7, 58
    jne t_skip_hash
    jmp t_tail
t_tail:
    ldb r7, [r1+0]
    cmp r7, 0
    je rw_done
    stb [r2+0], r7
    cmp r7, 10
    je rw_after
    add r1, 1
    add r2, 1
    jmp t_tail
rw_after:
    add r1, 1
    add r2, 1
rw_rest:
    ldb r7, [r1+0]
    cmp r7, 0
    je rw_done
    call line_copy
    jmp rw_rest
rw_done:
    mov r7, 0
    stb [r2+0], r7
    mov r1, outbuf
    call acct_write
    cmp r0, 0
    je pw_ok
    mov r0, 1
    mov r1, 2
    mov r2, wfail
    mov r3, 0
    sys
    mov r1, 1
    hlt
pw_ok:
    mov r0, 1
    mov r1, 1
    mov r2, okmsg
    mov r3, 0
    sys
    mov r1, 0
    hlt
${ARGN}
${ACCT_LOAD}
${ACCT_FIND}
${HASH_PASS}
${LINE_COPY}
${ACCT_WRITE}
${MEM_ITOA}
.data
${ACCT_DATA}
ruid:
    .word 0
tgt:
    .word 0
dash:
    .byte 0
tgtbuf:
    .space 32
p1:
    .space 32
p2:
    .space 32
outbuf:
    .space 640
userkey:
    .asciz "USER"
np1:
    .asciz "New password: "
np2:
    .asciz "Retype new password: "
nomatch:
    .asciz "passwd: passwords do not match\\n"
nosuch:
    .asciz "passwd: no such account\\n"
nouser:
    .asciz "passwd: USER not set\\n"
deny:
    .asciz "passwd: you may only change your own password\\n"
cancel:
    .asciz "passwd: cancelled\\n"
wfail:
    .asciz "passwd: cannot write /etc/passwd\\n"
okmsg:
    .asciz "password updated\\n"
`,

  useradd: `; useradd name — create an account: next free uid, no password,
; permissions lmbk, home directory /home/name. root only.
.text
_start:
    mov r4, r1
    mov r5, r2
    mov r0, 35
    sys
    cmp r1, 0
    je root_ok
    mov r0, 1
    mov r1, 2
    mov r2, deny
    mov r3, 0
    sys
    mov r1, 1
    hlt
root_ok:
    cmp r4, 1
    je have_name
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
have_name:
    ; argv 块不含程序名，argv[0] 就是用户名（r5 已指向它）
    mov r6, 0
    stw [r6+tgt], r5
    ; name: 1..8 chars, lowercase start, then letters/digits/_/-
    mov r1, r5
    mov r6, 0
v_loop:
    ldb r3, [r1+0]
    cmp r3, 0
    je v_len_ok
    cmp r6, 0
    jne v_notfirst
    cmp r3, 97
    jlt v_bad
    cmp r3, 122
    jgt v_bad
    jmp v_ok_ch
v_notfirst:
    cmp r3, 97
    jlt v_low
    cmp r3, 123
    jlt v_ok_ch
v_low:
    cmp r3, 48
    jlt v_other
    cmp r3, 58
    jlt v_ok_ch
v_other:
    cmp r3, 95
    je v_ok_ch
    cmp r3, 45
    jne v_bad
v_ok_ch:
    add r6, 1
    cmp r6, 9
    je v_bad
    add r1, 1
    jmp v_loop
v_len_ok:
    cmp r6, 0
    je v_bad
    jmp check_exists
v_bad:
    mov r0, 1
    mov r1, 2
    mov r2, badname
    mov r3, 0
    sys
    mov r1, 2
    hlt
check_exists:
    mov r6, 0
    ldw r5, [r6+tgt]
    call acct_find
    cmp r0, 0
    je exists
    ; new uid = max existing uid + 1（acctbuf still holds the table）
    mov r6, 0
    mov r5, acctbuf
mx_line:
    ldb r7, [r5+0]
    cmp r7, 0
    je mx_done
    cmp r7, 10
    je mx_skip
mx_name:
    ldb r7, [r5+0]
    cmp r7, 58
    je mx_uid
    cmp r7, 0
    je mx_done
    cmp r7, 10
    je mx_skip
    add r5, 1
    jmp mx_name
mx_uid:
    add r5, 1
    call atoi
    cmp r4, r6
    jlt mx_next
    mov r6, r4
mx_next:
mx_rest:
    ldb r7, [r5+0]
    cmp r7, 0
    je mx_done
    cmp r7, 10
    je mx_skip
    add r5, 1
    jmp mx_rest
mx_skip:
    add r5, 1
    jmp mx_line
mx_done:
    add r6, 1
    cmp r6, 256
    je full
    mov r0, 0
    stw [r0+new_uid], r6
    ; append the record to a copy of the table
    mov r1, acctbuf
    mov r2, outbuf
cp_loop:
    ldb r7, [r1+0]
    cmp r7, 0
    je cp_done
    stb [r2+0], r7
    add r1, 1
    add r2, 1
    jmp cp_loop
cp_done:
    mov r0, 0
    ldw r1, [r0+tgt]
ap_name:
    ldb r7, [r1+0]
    cmp r7, 0
    je ap_uid
    stb [r2+0], r7
    add r1, 1
    add r2, 1
    jmp ap_name
ap_uid:
    mov r7, 58
    stb [r2+0], r7
    add r2, 1
    mov r0, 0
    ldw r4, [r0+new_uid]
    mov r5, r2
    call mem_itoa
    mov r2, r5
    mov r1, ap_tail
ap_copy:
    ldb r7, [r1+0]
    stb [r2+0], r7
    cmp r7, 0
    je ap_written
    add r1, 1
    add r2, 1
    jmp ap_copy
ap_written:
    mov r1, outbuf
    call acct_write
    cmp r0, 0
    je home_dir
    mov r0, 1
    mov r1, 2
    mov r2, wfail
    mov r3, 0
    sys
    mov r1, 1
    hlt
home_dir:
    ; mkdir /home/<name> and chown it to the new account
    mov r1, homebuf
    mov r3, homepre
mh_pre:
    ldb r7, [r3+0]
    stb [r1+0], r7
    cmp r7, 0
    je mh_name
    add r1, 1
    add r3, 1
    jmp mh_pre
mh_name:
    ; r1 已停在 NUL 槽位，直接用名字覆盖该 NUL，无需回退
    mov r0, 0
    ldw r3, [r0+tgt]
mh_copy:
    ldb r7, [r3+0]
    cmp r7, 0
    je mh_ready
    stb [r1+0], r7
    add r1, 1
    add r3, 1
    jmp mh_copy
mh_ready:
    mov r7, 0
    stb [r1+0], r7
    mov r0, 14
    mov r1, homebuf
    sys
    cmp r0, 65535
    je no_home
    mov r0, 39
    mov r1, homebuf
    mov r2, 0
    ldw r2, [r2+new_uid]
    sys
no_home:
    mov r0, 1
    mov r1, 1
    mov r2, okmsg
    mov r3, 0
    sys
    mov r1, 0
    hlt
exists:
    mov r0, 1
    mov r1, 2
    mov r2, dup
    mov r3, 0
    sys
    mov r1, 1
    hlt
full:
    mov r0, 1
    mov r1, 2
    mov r2, fullmsg
    mov r3, 0
    sys
    mov r1, 1
    hlt
${ARGN}
${ACCT_LOAD}
${ACCT_FIND}
${ATOI}
${ACCT_WRITE}
${MEM_ITOA}
.data
${ACCT_DATA}
tgt:
    .word 0
new_uid:
    .word 0
outbuf:
    .space 640
homebuf:
    .space 64
homepre:
    .asciz "/home/"
ap_tail:
    .asciz ":-:lmbk\\n"
deny:
    .asciz "useradd: only root can create accounts\\n"
use:
    .asciz "usage: useradd name\\n"
badname:
    .asciz "useradd: bad name (1-8 chars, a-z start, [a-z0-9_-])\\n"
dup:
    .asciz "useradd: account exists\\n"
fullmsg:
    .asciz "useradd: uid space exhausted\\n"
wfail:
    .asciz "useradd: cannot write /etc/passwd\\n"
okmsg:
    .asciz "account created\\n"
`,

  userdel: `; userdel name — remove an account (root only, root itself protected).
; Also tries to remove an empty /home/name.
.text
_start:
    mov r4, r1
    mov r5, r2
    mov r0, 35
    sys
    cmp r1, 0
    je root_ok
    mov r0, 1
    mov r1, 2
    mov r2, deny
    mov r3, 0
    sys
    mov r1, 1
    hlt
root_ok:
    cmp r4, 1
    je have_name
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
have_name:
    ; argv[0] 就是目标账户名（argv 块不含程序名），r5 已指向它
    mov r6, 0
    stw [r6+tgt], r5
    call acct_find
    cmp r0, 0
    je known
    mov r0, 1
    mov r1, 2
    mov r2, nosuch
    mov r3, 0
    sys
    mov r1, 1
    hlt
known:
    mov r6, 0
    ldw r1, [r6+f_uid]
    cmp r1, 0
    je del_root
    ; rebuild the table without the target line
    mov r1, acctbuf
    mov r2, outbuf
    ldw r3, [r6+f_line]
ud_loop:
    ldb r7, [r1+0]
    cmp r7, 0
    je ud_done
    cmp r1, r3
    je ud_skip
    call line_copy
    jmp ud_loop
ud_skip:
    ldb r7, [r1+0]
    cmp r7, 0
    je ud_done
    cmp r7, 10
    je ud_skipped
    add r1, 1
    jmp ud_skip
ud_skipped:
    add r1, 1
    jmp ud_loop
ud_done:
    mov r7, 0
    stb [r2+0], r7
    mov r1, outbuf
    call acct_write
    cmp r0, 0
    je ud_ok
    mov r0, 1
    mov r1, 2
    mov r2, wfail
    mov r3, 0
    sys
    mov r1, 1
    hlt
ud_ok:
    ; best effort: remove /home/<name> if it is empty
    mov r1, homebuf
    mov r3, homepre
mh_pre:
    ldb r7, [r3+0]
    stb [r1+0], r7
    cmp r7, 0
    je mh_name
    add r1, 1
    add r3, 1
    jmp mh_pre
mh_name:
    ; r1 已停在 NUL 槽位，直接用名字覆盖该 NUL，无需回退
    mov r0, 0
    ldw r3, [r0+tgt]
mh_copy:
    ldb r7, [r3+0]
    cmp r7, 0
    je mh_ready
    stb [r1+0], r7
    add r1, 1
    add r3, 1
    jmp mh_copy
mh_ready:
    mov r7, 0
    stb [r1+0], r7
    mov r0, 13
    mov r1, homebuf
    sys
    mov r0, 1
    mov r1, 1
    mov r2, okmsg
    mov r3, 0
    sys
    mov r1, 0
    hlt
del_root:
    mov r0, 1
    mov r1, 2
    mov r2, rootmsg
    mov r3, 0
    sys
    mov r1, 1
    hlt
${ARGN}
${ACCT_LOAD}
${ACCT_FIND}
${LINE_COPY}
${ACCT_WRITE}
.data
${ACCT_DATA}
tgt:
    .word 0
outbuf:
    .space 640
homebuf:
    .space 64
homepre:
    .asciz "/home/"
deny:
    .asciz "userdel: only root can remove accounts\\n"
use:
    .asciz "usage: userdel name\\n"
nosuch:
    .asciz "userdel: no such account\\n"
rootmsg:
    .asciz "userdel: root cannot be removed\\n"
wfail:
    .asciz "userdel: cannot write /etc/passwd\\n"
okmsg:
    .asciz "account removed\\n"
`,

  chperm: `; chperm name perms — set an account's permission letters (l m b k a).
; root only; root's own permissions cannot be changed.
;   l login   m mount   b raw block io   k kill any process   a effective uid 0
.text
_start:
    mov r4, r1
    mov r5, r2
    mov r0, 35
    sys
    cmp r1, 0
    je root_ok
    mov r0, 1
    mov r1, 2
    mov r2, deny
    mov r3, 0
    sys
    mov r1, 1
    hlt
root_ok:
    cmp r4, 2
    je have_args
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
have_args:
    ; argv 块不含程序名：argv[0] = 账户名，argv[1] = 权限集
    mov r4, 0
    stw [r4+tgt], r5      ; r5 仍是 argv 基址 = argv[0]
    mov r5, r2
    mov r6, 1
    call argn             ; r5 = argv[1]
    ; sanitize the letter set into pset
    mov r1, r5
    mov r2, pset
    mov r6, 0
cv_loop:
    ldb r3, [r1+0]
    cmp r3, 0
    je cv_done
    cmp r3, 108
    je cv_ok
    cmp r3, 109
    je cv_ok
    cmp r3, 98
    je cv_ok
    cmp r3, 107
    je cv_ok
    cmp r3, 97
    jne cv_bad
cv_ok:
    mov r4, pset
cv_dup:
    ldb r7, [r4+0]
    cmp r7, 0
    je cv_add
    cmp r7, r3
    je cv_next
    add r4, 1
    jmp cv_dup
cv_add:
    cmp r6, 5
    je cv_bad
    stb [r2+0], r3
    add r2, 1
    add r6, 1
cv_next:
    add r1, 1
    jmp cv_loop
cv_done:
    mov r7, 0
    stb [r2+0], r7
    cmp r6, 0
    jne find_acct
    mov r2, pset
    mov r7, 45
    stb [r2+0], r7
    add r2, 1
    mov r7, 0
    stb [r2+0], r7
find_acct:
    mov r4, 0
    ldw r5, [r4+tgt]
    call acct_find
    cmp r0, 0
    je known
    mov r0, 1
    mov r1, 2
    mov r2, nosuch
    mov r3, 0
    sys
    mov r1, 1
    hlt
known:
    mov r4, 0
    ldw r1, [r4+f_uid]
    cmp r1, 0
    je root_bad
    ; rebuild: name:uid:hash:<new perms>
    mov r1, acctbuf
    mov r2, outbuf
    ldw r3, [r4+f_line]
cp_loop:
    cmp r1, r3
    je cp_target
    ldb r7, [r1+0]
    cmp r7, 0
    je cp_done
    call line_copy
    jmp cp_loop
cp_target:
t_name:
    ldb r7, [r1+0]
    stb [r2+0], r7
    add r1, 1
    add r2, 1
    cmp r7, 58
    jne t_name
t_uid:
    ldb r7, [r1+0]
    stb [r2+0], r7
    add r1, 1
    add r2, 1
    cmp r7, 58
    jne t_uid
t_hash:
    ldb r7, [r1+0]
    stb [r2+0], r7
    add r1, 1
    add r2, 1
    cmp r7, 58
    jne t_hash
    mov r4, pset
t_perms:
    ldb r7, [r4+0]
    cmp r7, 0
    je t_nl
    stb [r2+0], r7
    add r4, 1
    add r2, 1
    jmp t_perms
t_nl:
    mov r7, 10
    stb [r2+0], r7
    add r2, 1
t_skip:
    ldb r7, [r1+0]
    cmp r7, 0
    je cp_done
    cmp r7, 10
    je t_after
    add r1, 1
    jmp t_skip
t_after:
    add r1, 1
cp_rest:
    ldb r7, [r1+0]
    cmp r7, 0
    je cp_done
    call line_copy
    jmp cp_rest
cp_done:
    mov r7, 0
    stb [r2+0], r7
    mov r1, outbuf
    call acct_write
    cmp r0, 0
    je cp_ok
    mov r0, 1
    mov r1, 2
    mov r2, wfail
    mov r3, 0
    sys
    mov r1, 1
    hlt
cp_ok:
    mov r0, 1
    mov r1, 1
    mov r2, okmsg
    mov r3, 0
    sys
    mov r1, 0
    hlt
cv_bad:
    mov r0, 1
    mov r1, 2
    mov r2, badperms
    mov r3, 0
    sys
    mov r1, 2
    hlt
root_bad:
    mov r0, 1
    mov r1, 2
    mov r2, rootmsg
    mov r3, 0
    sys
    mov r1, 1
    hlt
${ARGN}
${ACCT_LOAD}
${ACCT_FIND}
${LINE_COPY}
${ACCT_WRITE}
.data
${ACCT_DATA}
tgt:
    .word 0
outbuf:
    .space 640
pset:
    .space 8
deny:
    .asciz "chperm: only root can change permissions\\n"
use:
    .asciz "usage: chperm name perms (letters l m b k a)\\n"
nosuch:
    .asciz "chperm: no such account\\n"
badperms:
    .asciz "chperm: perms must be letters from l m b k a\\n"
rootmsg:
    .asciz "chperm: root always keeps every permission\\n"
wfail:
    .asciz "chperm: cannot write /etc/passwd\\n"
okmsg:
    .asciz "permissions updated\\n"
`,

  chown: `; chown — change file owners: chown uid file...
.text
_start:
    cmp r1, 2
    jlt usage
    mov r0, 0
    stb [r0+left], r1
    mov r5, r2
    mov r6, 0
    call argn
    call atoi
    mov r0, 0
    stw [r0+uid], r4
skip_uid:
    ldb r7, [r5+0]
    cmp r7, 0
    je uid_skipped
    add r5, 1
    jmp skip_uid
uid_skipped:
    add r5, 1
    mov r0, 0
    ldb r7, [r0+left]
    sub r7, 1
    stb [r0+left], r7
each:
    mov r0, 0
    ldb r7, [r0+left]
    cmp r7, 1
    jlt done
    mov r1, r5
    ldw r2, [r0+uid]
    mov r0, 39
    sys
    cmp r0, 65535
    je failed
next:
    ldb r7, [r5+0]
    cmp r7, 0
    je adv
    add r5, 1
    jmp next
adv:
    add r5, 1
    mov r0, 0
    ldb r7, [r0+left]
    sub r7, 1
    stb [r0+left], r7
    jmp each
done:
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
usage:
    mov r0, 1
    mov r1, 2
    mov r2, use
    mov r3, 0
    sys
    mov r1, 2
    hlt
${ARGN}
${ATOI}
.data
left:
    .byte 0
uid:
    .word 0
err:
    .asciz "chown: cannot change owner\\n"
use:
    .asciz "usage: chown uid file...\\n"
`,
}
