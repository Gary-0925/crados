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
  init: `; init — pid 1, starts the shell and reaps every orphan
.text
_start:
    mov r0, 9
    mov r1, shpath
    sys
    mov r4, r0          ; shell pid
loop:
    mov r0, 10          ; wait for any child
    mov r1, 65535
    sys
    cmp r0, r4
    jne loop
    mov r0, 9           ; the shell exited, start a new one
    mov r1, shpath
    sys
    mov r4, r0
    jmp loop

.data
shpath:
    .asciz "/bin/sh"
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
    mov r2, pre
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
    mov r1, home
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
banner: .asciz "crados 2.0\\nType help for commands.\\n"
pre:    .asciz "user@crados:"
post:   .asciz "$ "
home:   .asciz "/home/user"
bgmsg:  .asciz "[background]\\n"
nf:     .asciz "sh: command not found\\n"
bye:    .asciz "logout\\n"
sfail:  .asciz "sh: cannot open script\\n"
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

  ls: `; ls — list a directory through getdents(2)
.text
_start:
    mov r4, dot
    cmp r1, 0
    je fetch
    mov r5, r2          ; skip option words, take the first real argument
    mov r6, r1
scan:
    cmp r6, 0
    je fetch
    ldb r7, [r5+0]
    cmp r7, 45
    jne take
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
take:
    mov r4, r5
fetch:
    mov r0, 11
    mov r1, r4
    mov r2, buf
    mov r3, 24
    sys
    cmp r0, 65535
    je failed
    mov r5, r0
    mov r6, 0
    mov r7, buf
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
    .space 384
dot:
    .asciz "."
gap:
    .ascii "  "
nl:
    .ascii "\\n"
err:
    .asciz "ls: cannot read directory\\n"
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
    .asciz "crados 2.0 browser js single-core\\n"
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
  // man 直接流式读取 /home/user/<页>.md，因此不受内核视图缓冲区大小限制
  man: `; man — stream a document out of /home/user
.text
_start:
    mov r4, path        ; dest cursor, shared by copystr
    mov r5, dir
    call copystr
    cmp r1, 0
    je usedefault
    mov r5, r2          ; argv[0] is the page name
    jmp copyname
usedefault:
    mov r5, defname
copyname:
    call copystr
    mov r5, ext
    call copystr
    mov r7, 0
    stb [r4+0], r7

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
dir:     .asciz "/home/user/"
defname: .asciz "README"
ext:     .asciz ".md"
err:     .asciz "man: no such page; try man README\\n"
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
}
