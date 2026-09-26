// CRX 内核策略。路径、权限、目录项和进程决策都在这里。
// 宿主只在 svc 40/41/42/44/45 时创建生成器、回收 PCB、镜像挂载表、运行汇编器或反汇编。
//
// spawn 请求（spawn_req，物理地址）：
//   0 device  1 inode  2 uid  4 euid  6 argc
//   8 name[16]  24 argv[160]  184 envLen  186 env[80]
//   266 cwdDev  267 cwdIno  268 flags（bit0 = 登录会话）

import {
  I_FLAGS,
  I_PARENT,
  INODE_SIZE,
  ITABLE_BYTE,
  M_EXEC,
  M_OEXEC,
  M_OREAD,
  M_OWRITE,
  M_READ,
  M_SETUID,
  M_WRITE,
  SB_UID,
  UID_ROOT,
} from './fs'
import { PCB_EUID, PCB_UID } from './process'

export const GUEST_POLICY_SOURCE = `
.text

gp_fail:
    mov r0, 65535
    iret

gp_ret_fail:
    mov r0, 65535
    ret

gp_use_vdev:
    mov r4, 0
    ldw r5, [r4+0x0040]
    stw [r4+0x0046], r5
    ret

; ---- credentials and permission decisions live here and only here ----

current_euid:
    call current_pcb
    ldw r0, [r5+${PCB_EUID}]
    ret

gp_bit_decide:
    cmp r1, ${UID_ROOT}
    je gp_bd_yes
    cmp r2, r1
    jne gp_bd_other
    mov r0, r3
    jmp gp_bd_test
gp_bd_other:
    mov r0, r7
gp_bd_test:
    and r0, r6
    cmp r0, 0
    je gp_bd_no
gp_bd_yes:
    mov r0, 0
    ret
gp_bd_no:
    mov r0, 65535
    ret

; vfs_may: r1 = inode，r2 = 属主位，r3 = 其他人位。0 允许，0xffff 拒绝。
; 判定只看 inode 自己的 flags（Unix 语义），走 gp_bit_decide（r7 = 其他人位）。
; 「子不超父」由创建（gp_create）和 chmod（gp_cap_flags）在写入时保证。
vfs_may:
    call ino_in_range
    cmp r0, 0
    jne vfs_may_no
    mov r4, 0
    stw [r4+0x00B0], r1
    stw [r4+0x00B2], r2
    stw [r4+0x00B4], r3
    call current_euid
    cmp r0, ${UID_ROOT}
    je vfs_may_yes
    mov r4, 0
    stw [r4+0x00B6], r0
    ldw r1, [r4+0x00B0]
    mul r1, 2
    add r1, ${SB_UID}
    call vfs_u16
    cmp r0, 65535
    je vfs_may_no
    mov r4, 0
    stw [r4+0x00AC], r0
    ldw r1, [r4+0x00B0]
    call vfs_inode
    cmp r0, 65280
    je vfs_may_no
    mov r1, r0
    add r1, ${I_FLAGS}
    call vfs_u8
    cmp r0, 65535
    je vfs_may_no
    mov r4, 0
    mov r6, r0
    ldw r1, [r4+0x00B6]
    ldw r2, [r4+0x00AC]
    ldw r3, [r4+0x00B2]
    ldw r7, [r4+0x00B4]
    call gp_bit_decide
    cmp r0, 0
    jne vfs_may_no
vfs_may_yes:
    mov r0, 0
    ret
vfs_may_no:
    mov r0, 65535
    ret

; may_write_ino: 写许可，走 sda 直读视图（crfs_*）。
may_write_ino:
    push r1
    call ino_in_range
    cmp r0, 0
    jne may_pop_no
    call current_euid
    cmp r0, ${UID_ROOT}
    je may_pop_yes
    mov r4, 0
    stw [r4+0x00B6], r0
    pop r1
    push r1
    mul r1, 2
    add r1, ${SB_UID}
    call crfs_u16
    cmp r0, 65535
    je may_no
    mov r4, 0
    stw [r4+0x00BA], r0
    pop r1
    push r1
    mul r1, ${INODE_SIZE}
    add r1, ${ITABLE_BYTE + I_FLAGS}
    call crfs_u8
    mov r3, r0
may_flag_have:
    mov r4, 0
    pop r1
    mov r6, r3
    ldw r1, [r4+0x00B6]
    ldw r2, [r4+0x00BA]
    mov r3, ${M_WRITE}
    mov r7, ${M_OWRITE}
    call gp_bit_decide
    cmp r0, 0
    jne may_no
    jmp may_yes
may_pop_yes:
    pop r1
    mov r0, 0
    ret
may_pop_no:
    pop r1
    jmp may_no
may_no:
    mov r0, 65535
    ret
may_yes:
    mov r0, 0
    ret

; gp_perm_ok: r1 = 权限字母 (108 l / 109 m / 98 b / 107 k)。
; 宿主查 sda 上 /etc/passwd 的当前账户：0 允许，0xffff 拒绝。
; euid 0 永远允许。除 r0 外不破坏任何寄存器（svc 会写 r0/r1）。
gp_perm_ok:
    push r2
    mov r2, r1
    mov r1, 1
    mov r0, 43
    svc
    pop r2
    ret

; gp_may_signal: r1 = 目标 pid。0 允许，0xffff 拒绝。kernel.ts 的 maySignalFg 是它的宿主镜像。
; root、带 k 权限的账户、或与目标同属主的进程可以发信号。
gp_may_signal:
    push r1
    call current_euid
    cmp r0, ${UID_ROOT}
    je gp_ms_root
    mov r1, 107
    call gp_perm_ok
    cmp r0, 0
    je gp_ms_yes_pop
    call current_euid
    mov r7, r0
    mov r4, 0
gp_ms_scan:
    cmp r4, 16
    je gp_ms_no
    mov r5, r4
    mul r5, 192
    add r5, 0x0100
    ldb r6, [r5+0]
    cmp r6, 1
    jne gp_ms_next
    ldw r6, [r5+2]
    cmp r6, r1
    je gp_ms_hit
gp_ms_next:
    add r4, 1
    jmp gp_ms_scan
gp_ms_hit:
    ldw r6, [r5+${PCB_EUID}]
    cmp r6, r7
    je gp_ms_yes_pop
    ldw r6, [r5+${PCB_UID}]
    cmp r6, r7
    je gp_ms_yes_pop
gp_ms_no:
    pop r1
    mov r0, 65535
    ret
gp_ms_root:
gp_ms_yes_pop:
    pop r1
    mov r0, 0
    ret


; r1 = user path. r0 = address of the last slash, or 0.
gp_last_slash:
    mov r0, 0
    mov r2, r1
gp_ls_loop:
    uldb r3, [r2+0]
    cmp r3, 0
    je gp_ls_done
    cmp r3, 47
    jne gp_ls_next
    mov r0, r2
gp_ls_next:
    add r2, 1
    jmp gp_ls_loop
gp_ls_done:
    ret

; r1 = user path. Success: r0 = parent inode, 0x0052 = name pointer, v_dev set.
gp_split:
    mov r4, 0
    stw [r4+0x0050], r1
    call gp_last_slash
    mov r4, 0
    cmp r0, 0
    je gp_split_rel
    ldw r1, [r4+0x0050]
    cmp r0, r1
    je gp_split_root
    mov r2, r0
    add r2, 1
    stw [r4+0x0052], r2
    uldb r3, [r2+0]
    cmp r3, 0
    je gp_ret_fail
    push r0
    mov r3, 0
    ustb [r0+0], r3
    ldw r1, [r4+0x0050]
    call vfs_resolve
    pop r2
    mov r3, 47
    ustb [r2+0], r3
    ret
gp_split_root:
    mov r2, r0
    add r2, 1
    stw [r4+0x0052], r2
    uldb r3, [r2+0]
    cmp r3, 0
    je gp_ret_fail
    push r2
    push r3
    mov r3, 0
    ustb [r2+0], r3
    ldw r1, [r4+0x0050]
    call vfs_resolve
    pop r3
    pop r2
    ustb [r2+0], r3
    ret
gp_split_rel:
    ldw r1, [r4+0x0050]
    stw [r4+0x0052], r1
    mov r1, 0
    call vfs_resolve
    ret

; r1 = user name. 0 if 1..14 bytes and not "." / "..".
gp_name_ok:
    uldb r3, [r1+0]
    cmp r3, 0
    je gp_ret_fail
    cmp r3, 46
    jne gp_name_len
    uldb r3, [r1+1]
    cmp r3, 0
    je gp_ret_fail
    cmp r3, 46
    jne gp_name_len
    uldb r3, [r1+2]
    cmp r3, 0
    je gp_ret_fail
gp_name_len:
    mov r0, 0
gp_name_len_loop:
    uldb r3, [r1+0]
    cmp r3, 0
    je gp_name_len_done
    add r0, 1
    add r1, 1
    cmp r0, 14
    jgt gp_ret_fail
    jmp gp_name_len_loop
gp_name_len_done:
    mov r0, 0
    ret

; Allocate an inode on the device selected by 0x0046. Returns inode or 65535.
gp_alloc_ino:
    mov r1, 0
    call sda_read_block
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 0
    mov r1, 0x0D00
    ldw r0, [r1+8]
    mov r4, 0
    stw [r4+0x00AC], r0
    mov r1, 2
    call sda_read_block
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 1
gp_ino_scan:
    mov r5, 0
    ldw r7, [r5+0x00AC]
    cmp r4, r7
    je gp_ret_fail
    mov r5, r4
    div r5, 8
    mov r6, r4
    mod r6, 8
    mov r7, 1
    shl r7, r6
    add r5, 0x0D00
    ldb r0, [r5+0]
    mov r1, r0
    and r1, r7
    cmp r1, 0
    je gp_ino_found
    add r4, 1
    jmp gp_ino_scan
gp_ino_found:
    or r0, r7
    stb [r5+0], r0
    mov r6, 0
    stw [r6+0x0064], r4
    mov r1, 2
    call sda_write_block
    cmp r0, 0
    jne gp_ret_fail
    ; A reused slot still holds the previous size and block pointers.
    mov r4, 0
    ldw r1, [r4+0x0064]
    mul r1, 48
    add r1, 768
    mov r5, r1
    div r5, 256
    mov r6, r1
    mod r6, 256
    stw [r4+0x0066], r5
    stw [r4+0x0068], r6
    mov r1, r5
    call sda_read_block
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 0
    ldw r6, [r4+0x0068]
    add r6, 0x0D00
    mov r7, 0
    mov r3, 0
gp_ino_zero:
    cmp r3, 48
    je gp_ino_zero_write
    cmp r6, 0x0E00
    je gp_ino_zero_write
    stb [r6+0], r7
    add r6, 1
    add r3, 1
    jmp gp_ino_zero
gp_ino_zero_write:
    mov r4, 0
    ldw r1, [r4+0x0066]
    push r3
    call sda_write_block
    pop r3
    cmp r0, 0
    jne gp_ret_fail
    cmp r3, 48
    je gp_ino_zero_done
    mov r4, 0
    ldw r1, [r4+0x0066]
    add r1, 1
    stw [r4+0x0066], r1
    call sda_read_block
    cmp r0, 0
    jne gp_ret_fail
    mov r6, 0x0D00
    mov r7, 0
gp_ino_zero_tail:
    cmp r3, 48
    je gp_ino_zero_write
    stb [r6+0], r7
    add r6, 1
    add r3, 1
    jmp gp_ino_zero_tail
gp_ino_zero_done:
    mov r6, 0
    ldw r0, [r6+0x0064]
    ret

; r1 = block number. Metadata blocks are left alone.
gp_free_block:
    cmp r1, 15
    jlt gp_free_skip
    mov r4, 0
    stw [r4+0x0066], r1
    mov r1, 1
    call sda_read_block
    cmp r0, 0
    jne gp_free_skip
    mov r4, 0
    ldw r1, [r4+0x0066]
    mov r5, r1
    div r5, 8
    mov r6, r1
    mod r6, 8
    mov r7, 1
    shl r7, r6
    xor r7, 65535
    add r5, 0x0D00
    ldb r0, [r5+0]
    and r0, r7
    stb [r5+0], r0
    mov r1, 1
    call sda_write_block
gp_free_skip:
    ret

; r1 = inode. Drops data blocks and the inode bitmap bit. Override must be set.
gp_destroy_ino:
    mov r4, 0
    stw [r4+0x0068], r1
    mov r6, 0
gp_destroy_ptr:
    cmp r6, 20
    je gp_destroy_bit
    mov r4, 0
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 768
    add r1, 8
    mov r5, r6
    mul r5, 2
    add r1, r5
    push r6
    call crfs_u16
    pop r6
    cmp r0, 0
    je gp_destroy_next
    cmp r0, 65535
    je gp_destroy_next
    push r6
    mov r1, r0
    call gp_free_block
    pop r6
gp_destroy_next:
    add r6, 1
    jmp gp_destroy_ptr
gp_destroy_bit:
    mov r1, 2
    call sda_read_block
    cmp r0, 0
    jne gp_free_skip
    mov r4, 0
    ldw r1, [r4+0x0068]
    mov r5, r1
    div r5, 8
    mov r6, r1
    mod r6, 8
    mov r7, 1
    shl r7, r6
    xor r7, 65535
    add r5, 0x0D00
    ldb r0, [r5+0]
    and r0, r7
    stb [r5+0], r0
    mov r1, 2
    call sda_write_block
    mov r4, 0
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 768
    mov r2, 0
    call crfs_write_u8
    ret

; r1 = inode. Truncate to zero. Override must be set.
gp_trunc:
    mov r4, 0
    stw [r4+0x0068], r1
    mov r6, 0
gp_trunc_loop:
    cmp r6, 20
    je gp_trunc_size
    mov r4, 0
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 768
    add r1, 8
    mov r5, r6
    mul r5, 2
    add r1, r5
    push r6
    call crfs_u16
    pop r6
    cmp r0, 0
    je gp_trunc_clear
    cmp r0, 65535
    je gp_trunc_next
    push r6
    mov r1, r0
    call gp_free_block
    pop r6
gp_trunc_clear:
    mov r4, 0
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 776
    mov r5, r6
    mul r5, 2
    add r1, r5
    mov r2, 0
    push r6
    call crfs_write_u16
    pop r6
gp_trunc_next:
    add r6, 1
    jmp gp_trunc_loop
gp_trunc_size:
    mov r4, 0
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 770
    mov r2, 0
    call crfs_write_u16
    ret

; r1 = dir inode, r2 = child inode, r3 = user name. Override must be set.
gp_dir_append:
    mov r4, 0
    stw [r4+0x0068], r1
    stw [r4+0x006A], r2
    stw [r4+0x006C], r3
    mov r1, r1
    mul r1, 48
    add r1, 770
    call crfs_u16
    cmp r0, 65535
    je gp_ret_fail
    cmp r0, 5120
    jlt gp_dir_size_ok
    jmp gp_ret_fail
gp_dir_size_ok:
    mov r4, 0
    stw [r4+0x006E], r0
    mov r5, r0
    div r5, 256
    mov r6, r0
    mod r6, 256
    stw [r4+0x0070], r5
    stw [r4+0x0072], r6
    cmp r6, 0
    jne gp_dir_old
    call crfs_alloc_block
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x0066], r0
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 776
    ldw r5, [r4+0x0070]
    mul r5, 2
    add r1, r5
    ldw r2, [r4+0x0066]
    call crfs_write_u16
    cmp r0, 0
    jne gp_ret_fail
    jmp gp_dir_fill
gp_dir_old:
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 776
    ldw r5, [r4+0x0070]
    mul r5, 2
    add r1, r5
    call crfs_u16
    cmp r0, 0
    je gp_ret_fail
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x0066], r0
gp_dir_fill:
    mov r4, 0
    ldw r1, [r4+0x0066]
    call sda_read_block
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 0
    ldw r4, [r4+0x0072]
    add r4, 0x0D00
    mov r6, 0
    ldw r2, [r6+0x006A]
    stw [r4+0], r2
    ldw r3, [r6+0x006C]
    mov r5, 0
gp_dir_name:
    cmp r5, 14
    je gp_dir_commit
    uldb r7, [r3+0]
    mov r0, r4
    add r0, 2
    add r0, r5
    stb [r0+0], r7
    cmp r7, 0
    je gp_dir_pad
    add r3, 1
    add r5, 1
    jmp gp_dir_name
gp_dir_pad:
    add r5, 1
    cmp r5, 14
    je gp_dir_commit
    mov r7, 0
    mov r0, r4
    add r0, 2
    add r0, r5
    stb [r0+0], r7
    jmp gp_dir_pad
gp_dir_commit:
    mov r6, 0
    ldw r1, [r6+0x0066]
    call sda_write_block
    cmp r0, 0
    jne gp_ret_fail
    ldw r1, [r6+0x0068]
    mul r1, 48
    add r1, 770
    ldw r2, [r6+0x006E]
    add r2, 16
    call crfs_write_u16
    ret

; gp_cap_flags: r1 = inode, r2 = 候选 flags → r0 = r2 ∩ 父目录 flags（根目录不封顶）。
; 只在 chmod 时用：不允许给文件加上父目录都没有的位。权限检查本身只看
; inode 自己的 flags（Unix 语义），目录的位负责守住目录里的进出。
; vfs_u8/vfs_u16 破坏 r1-r5，候选值暂存 0x0078。
gp_cap_flags:
    mov r4, 0
    stw [r4+0x0078], r2
    cmp r1, 1
    je gp_cap_keep
    call vfs_inode
    cmp r0, 65280
    je gp_cap_keep
    add r0, ${I_PARENT}
    mov r1, r0
    call vfs_u16
    cmp r0, 65535
    je gp_cap_keep
    cmp r0, 0
    je gp_cap_keep
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_cap_keep
    add r0, ${I_FLAGS}
    mov r1, r0
    call vfs_u8
    mov r4, 0
    ldw r2, [r4+0x0078]
    and r2, r0
    stw [r4+0x0078], r2
gp_cap_keep:
    mov r4, 0
    ldw r0, [r4+0x0078]
    ret

; r1 = user path, r2 = type. Creates the inode and links it. 0 or 65535.
gp_create:
    mov r4, 0
    stw [r4+0x0060], r2
    call gp_split
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x0062], r0
    ldw r5, [r4+0x0040]
    cmp r5, 254
    je gp_ret_fail
    ldw r5, [r4+0x0042]
    cmp r5, 1
    jne gp_ret_fail
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_ret_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 2
    jne gp_ret_fail
    mov r4, 0
    ldw r1, [r4+0x0062]
    mov r2, ${M_WRITE}
    mov r3, ${M_OWRITE}
    call vfs_may
    cmp r0, 0
    jne gp_ret_fail
    ldw r1, [r4+0x0052]
    call gp_name_ok
    cmp r0, 0
    jne gp_ret_fail
    ldw r1, [r4+0x0062]
    ldw r2, [r4+0x0052]
    call vfs_lookup
    cmp r0, 65535
    jne gp_ret_fail
    call gp_use_vdev
    call gp_alloc_ino
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x0064], r0
    mov r1, r0
    mul r1, 48
    add r1, 768
    ldw r2, [r4+0x0060]
    call crfs_write_u8
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 0
    ldw r1, [r4+0x0064]
    mul r1, 48
    add r1, 769
    mov r2, 14
    ldw r3, [r4+0x0060]
    cmp r3, 2
    jne gp_create_file
    mov r2, 143
    jmp gp_create_store
gp_create_file:
    stw [r4+0x0066], r2
    ldw r1, [r4+0x0062]
    call vfs_inode
    cmp r0, 65280
    je gp_create_file_raw
    add r0, 1
    mov r1, r0
    call vfs_u8
    mov r4, 0
    ldw r2, [r4+0x0066]
    and r2, r0
    jmp gp_create_store
gp_create_file_raw:
    mov r4, 0
    ldw r2, [r4+0x0066]
gp_create_store:
    ldw r1, [r4+0x0064]
    mul r1, 48
    add r1, 769
    call crfs_write_u8
    mov r4, 0
    ldw r1, [r4+0x0064]
    mul r1, 48
    add r1, 772
    ldw r2, [r4+0x0062]
    call crfs_write_u16
    call current_euid
    mov r2, r0
    mov r4, 0
    ldw r1, [r4+0x0064]
    mul r1, 2
    add r1, ${SB_UID}
    call crfs_write_u16
    mov r4, 0
    ldw r1, [r4+0x0062]
    ldw r2, [r4+0x0064]
    ldw r3, [r4+0x0052]
    call gp_dir_append
    ret

gp_open:
    mov r4, 0
    stw [r4+0x0050], r1
    stw [r4+0x0054], r2
    call vfs_resolve
    cmp r0, 65535
    jne gp_open_found
    mov r4, 0
    ldw r2, [r4+0x0054]
    cmp r2, 0
    je gp_fail
    ldw r1, [r4+0x0050]
    mov r2, 1
    call gp_create
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0050]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
gp_open_found:
    mov r4, 0
    stw [r4+0x0056], r0
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 2
    je gp_fail
    cmp r0, 3
    je gp_open_dev
    mov r4, 0
    ldw r2, [r4+0x0054]
    cmp r2, 0
    jne gp_open_write
    ldw r1, [r4+0x0056]
    mov r2, ${M_READ}
    mov r3, ${M_OREAD}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    mov r6, 0
    mov r7, 0
    jmp gp_open_file
gp_open_write:
    mov r4, 0
    ldw r5, [r4+0x0040]
    cmp r5, 254
    je gp_fail
    ldw r5, [r4+0x0042]
    cmp r5, 1
    jne gp_fail
    ldw r1, [r4+0x0056]
    mov r2, ${M_WRITE}
    mov r3, ${M_OWRITE}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    call gp_use_vdev
    ldw r2, [r4+0x0054]
    cmp r2, 1
    jne gp_open_append
    ldw r1, [r4+0x0056]
    call gp_trunc
    mov r7, 0
    jmp gp_open_wflags
gp_open_append:
    mov r4, 0
    ldw r1, [r4+0x0056]
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    add r0, 2
    mov r1, r0
    call vfs_u16
    mov r7, r0
gp_open_wflags:
    mov r4, 0
    ldw r6, [r4+0x0054]
gp_open_file:
    mov r4, 0
    stw [r4+0x0058], r6
    stw [r4+0x005A], r7
    mov r6, 6
    jmp gp_open_install
gp_open_dev:
    mov r4, 0
    ldw r2, [r4+0x0054]
    cmp r2, 0
    jne gp_open_dev_w
    ldw r1, [r4+0x0056]
    mov r2, ${M_READ}
    mov r3, ${M_OREAD}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    jmp gp_open_dev_kind
gp_open_dev_w:
    mov r4, 0
    ldw r5, [r4+0x0040]
    cmp r5, 254
    je gp_fail
    ldw r1, [r4+0x0056]
    mov r2, ${M_WRITE}
    mov r3, ${M_OWRITE}
    call vfs_may
    cmp r0, 0
    jne gp_fail
gp_open_dev_kind:
    mov r4, 0
    ldw r1, [r4+0x0056]
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    add r0, 6
    mov r1, r0
    call vfs_u8
    mov r6, 5
    cmp r0, 1
    jne gp_open_install
    mov r6, 4
gp_open_install:
    mov r4, 3
gp_open_scan:
    cmp r4, 8
    je gp_fail
    call current_pcb
    mov r7, r4
    mul r7, 6
    add r5, 41
    add r5, r7
    ldb r0, [r5+0]
    cmp r0, 0
    je gp_open_slot
    add r4, 1
    jmp gp_open_scan
gp_open_slot:
    mov r0, r6
    stb [r5+0], r0
    mov r7, 0
    ldw r0, [r7+0x0040]
    stb [r5+1], r0
    ldw r0, [r7+0x0056]
    stb [r5+2], r0
    mov r0, 0
    stb [r5+3], r0
    stw [r5+4], r0
    cmp r6, 6
    jne gp_open_count
    ldw r0, [r7+0x0058]
    stb [r5+3], r0
    ldw r0, [r7+0x005A]
    stw [r5+4], r0
gp_open_count:
    call current_pcb
    ldb r0, [r5+40]
    add r0, 1
    stb [r5+40], r0
    mov r0, r4
    iret

gp_chmod:
    mov r4, 0
    stw [r4+0x0050], r1
    stw [r4+0x0052], r2
    stw [r4+0x0054], r3
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0056], r0
    ldw r5, [r4+0x0040]
    cmp r5, 254
    je gp_fail
    ldw r5, [r4+0x0042]
    cmp r5, 1
    jne gp_fail
    call current_euid
    cmp r0, ${UID_ROOT}
    je gp_chmod_apply
    stw [r4+0x0058], r0
    ldw r1, [r4+0x0056]
    mul r1, 2
    add r1, ${SB_UID}
    call vfs_u16
    mov r4, 0
    ldw r5, [r4+0x0058]
    cmp r0, r5
    jne gp_fail
gp_chmod_apply:
    call gp_use_vdev
    mov r4, 0
    ldw r1, [r4+0x0056]
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    add r0, 1
    stw [r4+0x005A], r0
    mov r1, r0
    call crfs_u8
    cmp r0, 65535
    je gp_fail
    mov r6, r0
    call current_euid
    mov r4, 0
    ldw r2, [r4+0x0052]
    cmp r0, 0
    je gp_chmod_or
    mov r3, ${M_SETUID}
    xor r3, 65535
    and r2, r3
gp_chmod_or:
    mov r0, r6
    or r0, r2
    ldw r2, [r4+0x0054]
    xor r2, 65535
    and r0, r2
    and r0, 255
    ; 上限只取父目录一级（且不包含 inode 自己的旧模式），否则任何尚未
    ; 置位的权限都永远设不上去。
    stw [r4+0x005C], r0
    ldw r1, [r4+0x0056]
    ldw r2, [r4+0x005C]
    call gp_cap_flags
    stw [r4+0x005C], r0
gp_chmod_store:
    mov r4, 0
    ldw r2, [r4+0x005C]
    ldw r1, [r4+0x005A]
    call crfs_write_u8
    cmp r0, 0
    jne gp_fail
    mov r0, 0
    iret

gp_chdir:
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0056], r0
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 2
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0056]
    mov r2, ${M_EXEC}
    mov r3, ${M_OEXEC}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    call current_pcb
    mov r4, 0
    ldw r6, [r4+0x0040]
    stb [r5+22], r6
    ldw r6, [r4+0x0056]
    stb [r5+23], r6
    mov r0, 0
    iret

gp_mkdir:
    mov r2, 2
    call gp_create
    cmp r0, 0
    jne gp_fail
    mov r0, 0
    iret

; r1 = parent, r2 = child. Copies the child's directory name to gp_slot.
gp_copy_name:
    mov r4, 0
    stw [r4+0x0068], r1
    stw [r4+0x006A], r2
    mov r1, r1
    call vfs_count
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x006C], r0
    mov r6, 0
gp_copy_scan:
    mov r4, 0
    ldw r3, [r4+0x006C]
    cmp r6, r3
    je gp_ret_fail
    ldw r1, [r4+0x0068]
    mov r3, r6
    push r6
    call vfs_dirent
    pop r6
    mov r4, 0
    ldw r2, [r4+0x006A]
    cmp r0, r2
    je gp_copy_hit
    add r6, 1
    jmp gp_copy_scan
gp_copy_hit:
    mov r1, gp_slot
    mov r7, 0
gp_copy_bytes:
    cmp r7, 14
    je gp_copy_nul
    ldb r0, [r5+0]
    stb [r1+0], r0
    add r5, 1
    add r1, 1
    add r7, 1
    jmp gp_copy_bytes
gp_copy_nul:
    mov r0, 0
    stb [r1+0], r0
    mov r0, 0
    ret

gp_unlink:
    call gp_do_unlink
    cmp r0, 65535
    je gp_fail
    mov r0, 0
    iret

gp_do_unlink:
    mov r4, 0
    stw [r4+0x0050], r1
    call vfs_resolve
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x0056], r0
    cmp r0, 1
    je gp_ret_fail
    ldw r5, [r4+0x0040]
    cmp r5, 254
    je gp_ret_fail
    ldw r5, [r4+0x0042]
    cmp r5, 1
    jne gp_ret_fail
    call gp_is_mount
    cmp r0, 0
    je gp_ret_fail
    mov r4, 0
    ldw r1, [r4+0x0056]
    call vfs_inode
    cmp r0, 65280
    je gp_ret_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 3
    je gp_ret_fail
    cmp r0, 2
    jne gp_unlink_parent
    mov r4, 0
    ldw r1, [r4+0x0056]
    call vfs_count
    cmp r0, 0
    jne gp_ret_fail
gp_unlink_parent:
    mov r4, 0
    ldw r1, [r4+0x0050]
    call gp_split
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x0062], r0
    ldw r1, [r4+0x0062]
    call vfs_inode
    cmp r0, 65280
    je gp_ret_fail
    add r0, 1
    mov r1, r0
    call vfs_u8
    and r0, 64
    cmp r0, 0
    je gp_unlink_do
    call current_euid
    cmp r0, ${UID_ROOT}
    je gp_unlink_do
    mov r4, 0
    stw [r4+0x0058], r0
    ldw r1, [r4+0x0056]
    mul r1, 2
    add r1, ${SB_UID}
    call vfs_u16
    mov r4, 0
    ldw r5, [r4+0x0058]
    cmp r0, r5
    jne gp_ret_fail
gp_unlink_do:
    call gp_use_vdev
    mov r4, 0
    ldw r1, [r4+0x0062]
    ldw r2, [r4+0x0052]
    call gp_dir_remove
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 0
    ldw r1, [r4+0x0056]
    call gp_destroy_ino
    mov r0, 0
    ret

; 0 if (v_dev, r1 inode) is a mount point, else 1.
gp_is_mount:
    mov r4, 0
    ldw r6, [r4+0x0040]
    ldw r7, [r4+0x0056]
    mov r4, 0x00C0
gp_mnt_scan:
    cmp r4, 0x00E0
    je gp_mnt_no
    ldb r5, [r4+0]
    cmp r5, r6
    jne gp_mnt_next
    ldb r5, [r4+1]
    cmp r5, r7
    je gp_mnt_yes
gp_mnt_next:
    add r4, 4
    jmp gp_mnt_scan
gp_mnt_yes:
    mov r0, 0
    ret
gp_mnt_no:
    mov r0, 1
    ret

; r1 = dir, r2 = user name. Removes that directory entry. Override must be set.
gp_dir_remove:
    mov r4, 0
    stw [r4+0x0068], r1
    stw [r4+0x006C], r2
    mov r1, r1
    call vfs_count
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x006E], r0
    mov r6, 0
gp_rm_scan:
    ldw r3, [r4+0x006E]
    cmp r6, r3
    je gp_ret_fail
    ldw r1, [r4+0x0068]
    mov r3, r6
    push r6
    call vfs_dirent
    pop r6
    mov r4, 0
    stw [r4+0x0066], r0
    ldw r1, [r4+0x006C]
    mov r2, r5
    push r6
    call gp_user_kern_eq
    pop r6
    cmp r0, 0
    je gp_rm_hit
    mov r4, 0
    add r6, 1
    jmp gp_rm_scan
gp_rm_hit:
    mov r4, 0
    stw [r4+0x0070], r6
    ldw r3, [r4+0x006E]
    sub r3, 1
    cmp r6, r3
    je gp_rm_shrink
    stw [r4+0x0072], r3
    ldw r1, [r4+0x0068]
    mov r3, r3
    call vfs_dirent
    mov r1, gp_ent
    mov r7, r5
    sub r7, 2
    mov r6, 0
gp_rm_save:
    cmp r6, 16
    je gp_rm_write
    ldb r0, [r7+0]
    stb [r1+0], r0
    add r7, 1
    add r1, 1
    add r6, 1
    jmp gp_rm_save
gp_rm_write:
    mov r4, 0
    ldw r1, [r4+0x0070]
    mul r1, 16
    mov r5, r1
    div r5, 256
    mov r6, r1
    mod r6, 256
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 776
    mul r5, 2
    add r1, r5
    call crfs_u16
    cmp r0, 0
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x0066], r0
    mov r1, r0
    call sda_read_block
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 0
    ldw r6, [r4+0x0070]
    mul r6, 16
    mod r6, 256
    add r6, 0x0D00
    mov r1, gp_ent
    mov r7, 0
gp_rm_put:
    cmp r7, 16
    je gp_rm_commit
    ldb r0, [r1+0]
    stb [r6+0], r0
    add r1, 1
    add r6, 1
    add r7, 1
    jmp gp_rm_put
gp_rm_commit:
    mov r4, 0
    ldw r1, [r4+0x0066]
    call sda_write_block
gp_rm_shrink:
    mov r4, 0
    ldw r2, [r4+0x006E]
    sub r2, 1
    mul r2, 16
    stw [r4+0x0072], r2
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 770
    call crfs_write_u16
    mov r4, 0
    ldw r2, [r4+0x0072]
    mov r5, r2
    mod r5, 256
    cmp r5, 0
    jne gp_rm_ok
    mov r5, r2
    div r5, 256
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 776
    mul r5, 2
    add r1, r5
    call crfs_u16
    cmp r0, 0
    je gp_rm_ok
    cmp r0, 65535
    je gp_rm_ok
    mov r1, r0
    call gp_free_block
    mov r4, 0
    ldw r2, [r4+0x0072]
    div r2, 256
    ldw r1, [r4+0x0068]
    mul r1, 48
    add r1, 776
    mul r2, 2
    add r1, r2
    mov r2, 0
    call crfs_write_u16
gp_rm_ok:
    mov r0, 0
    ret

; r1 = user string, r2 = kernel string. 0 if equal up to NUL.
gp_user_kern_eq:
    mov r7, 0
gp_uke_loop:
    cmp r7, 14
    je gp_uke_end
    uldb r3, [r1+0]
    ldb r4, [r2+0]
    cmp r3, 0
    je gp_uke_user0
    cmp r3, r4
    jne gp_ret_fail
    add r1, 1
    add r2, 1
    add r7, 1
    jmp gp_uke_loop
gp_uke_user0:
    cmp r4, 0
    jne gp_ret_fail
    mov r0, 0
    ret
gp_uke_end:
    uldb r3, [r1+0]
    cmp r3, 0
    jne gp_ret_fail
    mov r0, 0
    ret

gp_rename:
    mov r4, 0
    stw [r4+0x0050], r1
    stw [r4+0x0052], r2
    stw [r4+0x0074], r2 ; gp_split overwrites 0x0052 with the source basename
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0056], r0
    ldw r6, [r4+0x0040]
    stw [r4+0x0058], r6
    ldw r5, [r4+0x0042]
    cmp r5, 1
    jne gp_fail
    cmp r6, 254
    je gp_fail
    ldw r1, [r4+0x0056]
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 3
    je gp_fail
    mov r4, 0           ; vfs_sector leaves r4 at the block MMIO page
    ldw r1, [r4+0x0050]
    call gp_split
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0062], r0
    ldw r1, [r4+0x0074]
    call gp_split
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0060], r0
    ldw r5, [r4+0x0040]
    ldw r6, [r4+0x0058]
    cmp r5, r6
    jne gp_fail
    ldw r1, [r4+0x0062]
    mov r2, ${M_WRITE}
    mov r3, ${M_OWRITE}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0060]
    mov r2, ${M_WRITE}
    mov r3, ${M_OWRITE}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0062]
    ldw r2, [r4+0x0056]
    call gp_copy_name
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0060]
    ldw r2, [r4+0x0052]
    call vfs_lookup
    cmp r0, 65535
    je gp_ren_link
    ldw r1, [r4+0x0056]
    cmp r0, r1
    je gp_ren_ok
    stw [r4+0x0074], r0
    ldw r5, [r4+0x0056]
    stw [r4+0x0076], r5
    ldw r5, [r4+0x0062]
    stw [r4+0x0078], r5
    ldw r5, [r4+0x0060]
    stw [r4+0x007A], r5
    ldw r5, [r4+0x0052]
    stw [r4+0x007C], r5
    ldw r5, [r4+0x0058]
    stw [r4+0x007E], r5
    ldw r1, [r4+0x0052]
    call gp_do_unlink
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r5, [r4+0x0076]
    stw [r4+0x0056], r5
    ldw r5, [r4+0x0078]
    stw [r4+0x0062], r5
    ldw r5, [r4+0x007A]
    stw [r4+0x0060], r5
    ldw r5, [r4+0x007C]
    stw [r4+0x0052], r5
    ldw r5, [r4+0x007E]
    mov r1, r5
    call vfs_setdev
gp_ren_link:
    call gp_use_vdev
    mov r4, 0
    ldw r1, [r4+0x0062]
    ldw r2, [r4+0x0056]
    call gp_dir_remove_ino
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0060]
    ldw r2, [r4+0x0056]
    ldw r3, [r4+0x0052]
    call gp_dir_append
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0056]
    mul r1, 48
    add r1, 772
    ldw r2, [r4+0x0060]
    call crfs_write_u16
gp_ren_ok:
    mov r0, 0
    iret

; r1 = dir, r2 = child inode. Removes the entry whose inode matches.
gp_dir_remove_ino:
    mov r4, 0
    stw [r4+0x0068], r1
    stw [r4+0x006A], r2
    mov r1, r1
    call vfs_count
    cmp r0, 65535
    je gp_ret_fail
    mov r4, 0
    stw [r4+0x006E], r0
    mov r6, 0
gp_rmi_scan:
    ldw r3, [r4+0x006E]
    cmp r6, r3
    je gp_ret_fail
    ldw r1, [r4+0x0068]
    mov r3, r6
    push r6
    call vfs_dirent
    pop r6
    mov r4, 0
    ldw r2, [r4+0x006A]
    cmp r0, r2
    je gp_rm_hit
    add r6, 1
    jmp gp_rmi_scan

gp_getcwd:
    mov r4, 0
    stw [r4+0x0050], r1
    call current_pcb
    ldb r1, [r5+22]
    ldb r6, [r5+23]
    mov r4, 0
    stw [r4+0x0056], r6
    call vfs_setdev
    mov r7, 0
gp_cwd_walk:
    mov r4, 0
    ldw r1, [r4+0x0056]
    cmp r1, 1
    je gp_cwd_mount
    cmp r7, 8
    je gp_cwd_mount
    call vfs_inode
    cmp r0, 65280
    je gp_cwd_emit
    add r0, 4
    mov r1, r0
    call vfs_u16
    cmp r0, 0
    je gp_cwd_emit
    cmp r0, 65535
    je gp_cwd_emit
    mov r2, r0
    mov r4, 0
    ldw r1, [r4+0x0056]
    stw [r4+0x006A], r1
    mov r1, r2
    stw [r4+0x0056], r2
    ldw r2, [r4+0x006A]
    push r7
    call gp_copy_name
    pop r7
    cmp r0, 0
    jne gp_cwd_emit
    mov r1, gp_names
    mov r3, r7
    mul r3, 16
    add r1, r3
    mov r2, gp_slot
    mov r6, 0
gp_cwd_store:
    cmp r6, 15
    je gp_cwd_stored
    ldb r0, [r2+0]
    stb [r1+0], r0
    add r1, 1
    add r2, 1
    add r6, 1
    jmp gp_cwd_store
gp_cwd_stored:
    add r7, 1
    jmp gp_cwd_walk
gp_cwd_mount:
    mov r4, 0
    ldw r5, [r4+0x0040]
    cmp r5, 1
    je gp_cwd_emit
    mov r4, 0x00C0
gp_cwd_mscan:
    cmp r4, 0x00E0
    je gp_cwd_emit
    ldb r5, [r4+2]
    mov r6, 0
    ldw r6, [r6+0x0040]
    cmp r5, r6
    je gp_cwd_mhit
    add r4, 4
    jmp gp_cwd_mscan
gp_cwd_mhit:
    ldb r1, [r4+0]
    ldb r2, [r4+1]
    push r2
    push r7
    call vfs_setdev
    pop r7
    pop r2
    mov r4, 0
    stw [r4+0x0056], r2
    jmp gp_cwd_walk
gp_cwd_emit:
    mov r4, 0
    ldw r2, [r4+0x0050]
    mov r0, 47
    ustb [r2+0], r0
    add r2, 1
    cmp r7, 0
    je gp_cwd_nul
gp_cwd_out:
    sub r7, 1
    mov r1, gp_names
    mov r3, r7
    mul r3, 16
    add r1, r3
gp_cwd_out_ch:
    ldb r0, [r1+0]
    cmp r0, 0
    je gp_cwd_slash
    ustb [r2+0], r0
    add r2, 1
    add r1, 1
    jmp gp_cwd_out_ch
gp_cwd_slash:
    cmp r7, 0
    je gp_cwd_nul
    mov r0, 47
    ustb [r2+0], r0
    add r2, 1
    jmp gp_cwd_out
gp_cwd_nul:
    mov r0, 0
    ustb [r2+0], r0
    mov r4, 0
    ldw r1, [r4+0x0050]
    mov r0, r2
    sub r0, r1
    iret

gp_getenv:
    mov r4, 0
    stw [r4+0x0050], r1
    stw [r4+0x0052], r2
    call current_pcb
    ldw r3, [r5+10]
    cmp r3, 0
    je gp_env_empty
gp_env_key:
    mov r4, 0
    stw [r4+0x0054], r3
    ldw r1, [r4+0x0050]
    mov r2, r3
    call gp_user_eq
    mov r4, 0
    ldw r3, [r4+0x0054]
    cmp r0, 0
    je gp_env_value
    mov r1, r3
    call gp_user_skip
    mov r1, r0
    call gp_user_skip
    mov r3, r0
    uldb r5, [r3+0]
    cmp r5, 0
    je gp_env_empty
    jmp gp_env_key
gp_env_value:
    mov r4, 0
    ldw r3, [r4+0x0054]
    mov r1, r3
    call gp_user_skip
    mov r1, r0
    mov r4, 0
    ldw r2, [r4+0x0052]
    mov r0, 0
gp_env_copy:
    uldb r5, [r1+0]
    ustb [r2+0], r5
    cmp r5, 0
    je gp_env_ret
    add r1, 1
    add r2, 1
    add r0, 1
    jmp gp_env_copy
gp_env_ret:
    iret
gp_env_empty:
    mov r4, 0
    ldw r2, [r4+0x0052]
    mov r0, 0
    ustb [r2+0], r0
    iret

; r1 and r2 are user strings. 0 if equal.
gp_user_eq:
    uldb r3, [r1+0]
    uldb r4, [r2+0]
    cmp r3, r4
    jne gp_ret_fail
    cmp r3, 0
    je gp_user_eq_yes
    add r1, 1
    add r2, 1
    jmp gp_user_eq
gp_user_eq_yes:
    mov r0, 0
    ret

; r1 = user string. Returns pointer past the NUL.
gp_user_skip:
gp_user_skip_loop:
    uldb r3, [r1+0]
    add r1, 1
    cmp r3, 0
    jne gp_user_skip_loop
    mov r0, r1
    ret

gp_sleep_sec:
    cmp r1, 0
    je sleep_done
    mov r4, 0
    ldw r2, [r4+0x0024]
    mul r1, r2
    jmp sys_sleep

gp_exit_book:
    call current_pcb
    ldw r6, [r5+2]
    ldw r7, [r5+4]
    mov r3, 0
gp_exit_re:
    cmp r3, 16
    je gp_exit_wake
    mov r4, r3
    mul r4, 192
    add r4, 0x0100
    ldb r0, [r4+0]
    cmp r0, 1
    jne gp_exit_re_next
    ldw r0, [r4+4]
    cmp r0, r6
    jne gp_exit_re_next
    mov r0, 1
    stw [r4+4], r0
gp_exit_re_next:
    add r3, 1
    jmp gp_exit_re
gp_exit_wake:
    mov r3, 0
gp_exit_wscan:
    cmp r3, 16
    je gp_exit_wdone
    mov r4, r3
    mul r4, 192
    add r4, 0x0100
    ldb r0, [r4+0]
    cmp r0, 1
    jne gp_exit_wnext
    ldw r0, [r4+2]
    cmp r0, r7
    jne gp_exit_wnext
    ldb r0, [r4+1]
    cmp r0, 4
    jne gp_exit_wdone
    ldw r0, [r4+18]
    cmp r0, 65534
    je gp_exit_ready
    cmp r0, r6
    jne gp_exit_wdone
gp_exit_ready:
    mov r0, 2
    stb [r4+1], r0
    jmp gp_exit_wdone
gp_exit_wnext:
    add r3, 1
    jmp gp_exit_wscan
gp_exit_wdone:
    ret

gp_wait:
    call current_pcb
    cmp r1, 65535
    jne gp_wait_store
    mov r1, 65534
gp_wait_store:
    stw [r5+18], r1
gp_wait_scan:
    call current_pcb
    ldw r6, [r5+2]
    ldw r7, [r5+18]
    mov r3, 0
    mov r2, 0
gp_wait_loop:
    cmp r3, 16
    je gp_wait_none
    mov r4, r3
    mul r4, 192
    add r4, 0x0100
    ldb r0, [r4+0]
    cmp r0, 1
    jne gp_wait_next
    ldw r0, [r4+4]
    cmp r0, r6
    jne gp_wait_next
    ldw r0, [r4+2]
    cmp r7, 65534
    je gp_wait_match
    cmp r0, r7
    jne gp_wait_next
gp_wait_match:
    ldb r0, [r4+1]
    cmp r0, 5
    je gp_wait_reap
    mov r2, 1
gp_wait_next:
    add r3, 1
    jmp gp_wait_loop
gp_wait_none:
    cmp r2, 0
    je gp_fail
    call current_pcb
    mov r0, 4
    stb [r5+1], r0
    call do_schedule
    sched
    jmp gp_wait_scan
gp_wait_reap:
    ldw r6, [r4+2]
    ldw r7, [r4+12]
    mov r0, 0
    stb [r4+0], r0
    mov r4, 0
    stw [r4+0x0050], r6
    stw [r4+0x0052], r7
    ldw r1, [r4+0x002C]
    cmp r1, r6
    jne gp_wait_svc
    call current_pcb
    ldw r1, [r5+2]
    mov r4, 0
    stw [r4+0x002C], r1
gp_wait_svc:
    mov r0, 41
    mov r4, 0
    ldw r1, [r4+0x0050]
    svc
    mov r4, 0
    ldw r0, [r4+0x0050]
    ldw r1, [r4+0x0052]
    iret

gp_spawn:
    mov r4, 0
    stb [r4+0x0044], r4
    stw [r4+0x0050], r1
    stw [r4+0x0052], r2
    stw [r4+0x0054], r3
    call gp_req_zero
    mov r1, spawn_req
    add r1, 6
    mov r4, 0
    ldw r2, [r4+0x0054]
    stw [r1+0], r2
    ldw r1, [r4+0x0050]
    call gp_basename
    ldw r1, [r4+0x0050]
    call gp_has_slash
    cmp r0, 0
    jne gp_spawn_abs
    ldw r1, [r4+0x0050]
    call gp_search
    cmp r0, 65535
    je gp_fail
    jmp gp_spawn_check
gp_spawn_abs:
    ldw r1, [r4+0x0050]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
gp_spawn_check:
    mov r4, 0
    stw [r4+0x0056], r0
    ldw r5, [r4+0x0040]
    stw [r4+0x0058], r5
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 1
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0056]
    mov r2, ${M_EXEC}
    mov r3, ${M_OEXEC}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    call gp_setuid_from
    call gp_read_head
    cmp r0, 1
    je gp_spawn_image
    cmp r0, 2
    jne gp_fail
    call gp_shebang
    cmp r0, 0
    jne gp_fail
gp_spawn_image:
    call gp_fill_ids
    call gp_fill_env
    call gp_fill_argv
    mov r0, 40
    mov r1, spawn_req
    svc
    iret

; 系统调用 38: spawnas(path, uid)。仅限 euid 0（init 与 setuid-root 的 login）。
; 宿主核对账户存在且未锁定（op 2），并填写登录环境块与 home 目录（op 3）；
; 这里负责解析程序、确定 uid/euid 后按登录会话启动。
gp_spawnas:
    mov r4, 0
    stw [r4+0x0050], r1
    stw [r4+0x005E], r2
    call current_euid
    cmp r0, ${UID_ROOT}
    jne gp_fail
    mov r0, 43
    mov r1, 2
    ldw r2, [r4+0x005E]
    svc
    ; op2 合法返回 1/2；0 或 0xffff（锁定/不存在）都必须拒绝
    cmp r0, 0
    je gp_fail
    cmp r0, 65535
    je gp_fail
    mov r6, r0
    call gp_req_zero
    ldw r1, [r4+0x0050]
    call gp_basename
    ldw r1, [r4+0x0050]
    call gp_has_slash
    cmp r0, 0
    jne gp_sa_abs
    ldw r1, [r4+0x0050]
    call gp_search
    cmp r0, 65535
    je gp_fail
    jmp gp_sa_check
gp_sa_abs:
    ldw r1, [r4+0x0050]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
gp_sa_check:
    mov r4, 0
    stw [r4+0x0056], r0
    ldw r5, [r4+0x0040]
    stw [r4+0x0058], r5
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 1
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0056]
    mov r2, ${M_EXEC}
    mov r3, ${M_OEXEC}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    ldw r5, [r4+0x005E]
    stw [r4+0x005A], r5
    cmp r6, 2
    jne gp_sa_user
    mov r5, 0
gp_sa_user:
    stw [r4+0x005C], r5
    call gp_read_head
    cmp r0, 1
    je gp_sa_image
    cmp r0, 2
    jne gp_fail
    call gp_shebang
    cmp r0, 0
    jne gp_fail
gp_sa_image:
    call gp_fill_ids
    mov r0, 43
    mov r1, 3
    mov r2, spawn_req
    svc
    cmp r0, 0
    jne gp_fail
    mov r1, spawn_req
    mov r5, 1
    stb [r1+268], r5
    mov r0, 40
    mov r1, spawn_req
    svc
    iret

; 系统调用 39: chown(path, uid)。仅限 euid 0。改写 inode 属主表。
gp_chown:
    mov r4, 0
    stw [r4+0x0052], r2
    call current_euid
    cmp r0, ${UID_ROOT}
    jne gp_fail
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0056], r0
    ldw r5, [r4+0x0040]
    cmp r5, 254
    je gp_fail
    ldw r5, [r4+0x0042]
    cmp r5, 1
    jne gp_fail
    call gp_use_vdev
    ldw r1, [r4+0x0056]
    mul r1, 2
    add r1, ${SB_UID}
    ldw r2, [r4+0x0052]
    call crfs_write_u16
    cmp r0, 0
    jne gp_fail
    mov r0, 0
    iret

gp_req_zero:
    mov r1, spawn_req
    mov r2, 0
    mov r3, 0
gp_req_zero_loop:
    cmp r3, 272
    je gp_req_zero_done
    stb [r1+0], r2
    add r1, 1
    add r3, 1
    jmp gp_req_zero_loop
gp_req_zero_done:
    ret

gp_basename:
    call gp_last_slash
    cmp r0, 0
    je gp_base_whole
    add r0, 1
    mov r1, r0
gp_base_whole:
    mov r2, spawn_req
    add r2, 8
    mov r3, 0
gp_base_copy:
    cmp r3, 15
    je gp_base_done
    uldb r4, [r1+0]
    stb [r2+0], r4
    cmp r4, 0
    je gp_base_done
    add r1, 1
    add r2, 1
    add r3, 1
    jmp gp_base_copy
gp_base_done:
    mov r4, 0
    stb [r2+0], r4
    ret

; r1 = user path. r0 = 1 if it contains a slash.
gp_has_slash:
    mov r2, r1
gp_hs_loop:
    uldb r3, [r2+0]
    cmp r3, 0
    je gp_hs_no
    cmp r3, 47
    je gp_hs_yes
    add r2, 1
    jmp gp_hs_loop
gp_hs_yes:
    mov r0, 1
    ret
gp_hs_no:
    mov r0, 0
    ret

; r1 = command name. Tries /bin then /usr/bin. Returns inode or 65535.
gp_search:
    mov r4, 0
    stw [r4+0x0060], r1
    mov r1, gp_bin
    ldw r2, [r4+0x0060]
    call gp_join
    mov r4, 0
    mov r1, 1
    stb [r4+0x0048], r1
    mov r1, pathbuf
    call vfs_resolve
    mov r4, 0
    mov r1, 0
    stb [r4+0x0048], r1
    cmp r0, 65535
    jne gp_search_done
    mov r1, gp_usr
    ldw r2, [r4+0x0060]
    call gp_join
    mov r4, 0
    mov r1, 1
    stb [r4+0x0048], r1
    mov r1, pathbuf
    call vfs_resolve
    mov r4, 0
    mov r1, 0
    stb [r4+0x0048], r1
gp_search_done:
    ret

; r1 = kernel prefix, r2 = user suffix. Result in pathbuf.
gp_join:
    mov r3, pathbuf
gp_join_pre:
    ldb r4, [r1+0]
    cmp r4, 0
    je gp_join_user
    stb [r3+0], r4
    add r1, 1
    add r3, 1
    jmp gp_join_pre
gp_join_user:
    uldb r4, [r2+0]
    stb [r3+0], r4
    cmp r4, 0
    je gp_join_done
    add r2, 1
    add r3, 1
    jmp gp_join_user
gp_join_done:
    ret

; Applies setuid of the inode in 0x0056 / current v_dev onto 0x005C (euid).
gp_setuid_from:
    call current_pcb
    ldw r6, [r5+${PCB_UID}]
    ldw r7, [r5+${PCB_EUID}]
    mov r4, 0
    stw [r4+0x005A], r6
    stw [r4+0x005C], r7
    ldw r1, [r4+0x0056]
    call vfs_inode
    cmp r0, 65280
    je gp_setuid_done
    mov r1, r0
    add r1, 1
    call vfs_u8
    and r0, ${M_SETUID}
    cmp r0, 0
    je gp_setuid_done
    mov r4, 0
    ldw r1, [r4+0x0056]
    mul r1, 2
    add r1, ${SB_UID}
    call vfs_u16
    mov r4, 0
    stw [r4+0x005C], r0
gp_setuid_done:
    ret

; Reads the first sector. r0 = 1 CRX, 2 shebang, 0 neither.
gp_read_head:
    mov r4, 0
    ldw r1, [r4+0x0056]
    call vfs_inode
    cmp r0, 65280
    je gp_head_no
    add r0, 8
    mov r1, r0
    call vfs_u16
    cmp r0, 0
    je gp_head_no
    cmp r0, 65535
    je gp_head_no
    mov r1, r0
    mov r4, 0
    ldw r5, [r4+0x0042]
    mul r1, r5
    call vfs_sector
    cmp r0, 0
    jne gp_head_no
    mov r1, 0x0D00
    ldb r0, [r1+0]
    cmp r0, 127
    jne gp_head_bang
    ldb r0, [r1+1]
    cmp r0, 67
    jne gp_head_no
    ldb r0, [r1+2]
    cmp r0, 82
    jne gp_head_no
    ldb r0, [r1+3]
    cmp r0, 88
    jne gp_head_no
    mov r0, 1
    ret
gp_head_bang:
    cmp r0, 35
    jne gp_head_no
    ldb r0, [r1+1]
    cmp r0, 33
    jne gp_head_no
    mov r0, 2
    ret
gp_head_no:
    mov r0, 0
    ret

gp_shebang:
    mov r1, 0x0D02
gp_bang_sp:
    ldb r0, [r1+0]
    cmp r0, 32
    jne gp_bang_copy
    add r1, 1
    jmp gp_bang_sp
gp_bang_copy:
    mov r2, pathbuf
gp_bang_ch:
    ldb r0, [r1+0]
    cmp r0, 0
    je gp_bang_end
    cmp r0, 10
    je gp_bang_end
    cmp r0, 32
    je gp_bang_end
    stb [r2+0], r0
    add r1, 1
    add r2, 1
    jmp gp_bang_ch
gp_bang_end:
    mov r0, 0
    stb [r2+0], r0
    mov r4, 0
    mov r1, 1
    stb [r4+0x0048], r1
    mov r1, pathbuf
    call vfs_resolve
    mov r4, 0
    mov r1, 0
    stb [r4+0x0048], r1
    cmp r0, 65535
    je gp_ret_fail
    stw [r4+0x0056], r0
    ldw r5, [r4+0x0040]
    stw [r4+0x0058], r5
    mov r1, r0
    mov r2, ${M_EXEC}
    mov r3, ${M_OEXEC}
    call vfs_may
    cmp r0, 0
    jne gp_ret_fail
    mov r4, 0
    mov r1, 1
    stb [r4+0x0044], r1
    mov r0, 0
    ret

gp_fill_ids:
    mov r1, spawn_req
    mov r4, 0
    ldw r5, [r4+0x0058]
    stb [r1+0], r5
    ldw r5, [r4+0x0056]
    stb [r1+1], r5
    ldw r5, [r4+0x005A]
    stw [r1+2], r5
    ldw r5, [r4+0x005C]
    stw [r1+4], r5
    ret

gp_fill_env:
    mov r1, spawn_req
    ldb r0, [r1+268]
    cmp r0, 1
    je gp_env_login
    call current_pcb
    ldw r1, [r5+10]
    cmp r1, 0
    je gp_env_root
    mov r2, spawn_req
    add r2, 186
    mov r3, 0
gp_env_inherit:
    cmp r3, 78
    je gp_env_setlen
    uldb r0, [r1+0]
    stb [r2+0], r0
    add r1, 1
    add r2, 1
    add r3, 1
    jmp gp_env_inherit
; 登录会话的环境块由 gp_spawnas 通过宿主账户表填好，这里不再覆盖。
gp_env_login:
    ret
gp_env_root:
    mov r1, gp_root_env
gp_env_copy_k:
    mov r2, spawn_req
    add r2, 186
    mov r3, 0
gp_env_kloop:
    cmp r3, 78
    je gp_env_setlen
    ldb r0, [r1+0]
    stb [r2+0], r0
    add r1, 1
    add r2, 1
    add r3, 1
    cmp r0, 0
    jne gp_env_kloop
    ldb r0, [r1+0]
    cmp r0, 0
    jne gp_env_kloop
gp_env_setlen:
    mov r1, spawn_req
    add r1, 184
    mov r2, r3
    stw [r1+0], r2
    ret

gp_fill_argv:
    mov r1, spawn_req
    add r1, 24
    mov r4, 0
    ldb r0, [r4+0x0044]
    cmp r0, 1
    jne gp_argv_user
    ldw r2, [r4+0x0050]
gp_argv_script:
    uldb r0, [r2+0]
    stb [r1+0], r0
    add r1, 1
    add r2, 1
    cmp r0, 0
    jne gp_argv_script
    ldw r3, [r4+0x0054]
    add r3, 1
    mov r2, spawn_req
    add r2, 6
    stw [r2+0], r3
gp_argv_user:
    mov r4, 0
    ldw r2, [r4+0x0052]
    ldw r3, [r4+0x0054]
    cmp r3, 0
    je gp_argv_done
    cmp r2, 0
    je gp_argv_done
gp_argv_arg:
    cmp r3, 0
    je gp_argv_done
    uldb r0, [r2+0]
    stb [r1+0], r0
    add r1, 1
    add r2, 1
    cmp r0, 0
    jne gp_argv_arg
    sub r3, 1
    jmp gp_argv_arg
gp_argv_done:
    ret

gp_assemble:
    mov r4, 0
    stw [r4+0x0050], r1
    stw [r4+0x0052], r2
    stw [r4+0x007A], r2
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0056], r0
    ldw r5, [r4+0x0040]
    stw [r4+0x0058], r5
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 1
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0056]
    mov r2, ${M_READ}
    mov r3, ${M_OREAD}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    ldw r1, [r4+0x0052]
    call vfs_resolve
    cmp r0, 65535
    jne gp_as_dest
    ldw r1, [r4+0x0052]
    mov r2, 1
    call gp_create
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x007A]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
gp_as_dest:
    mov r4, 0
    stw [r4+0x0060], r0
    ldw r5, [r4+0x0040]
    cmp r5, 254
    je gp_fail
    stw [r4+0x0062], r5
    mov r1, r0
    mov r2, ${M_WRITE}
    mov r3, ${M_OWRITE}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    mov r1, gp_as_req
    ldw r5, [r4+0x0058]
    stb [r1+0], r5
    ldw r5, [r4+0x0056]
    stb [r1+1], r5
    ldw r5, [r4+0x0062]
    stb [r1+2], r5
    ldw r5, [r4+0x0060]
    stb [r1+3], r5
    mov r0, 44
    mov r1, gp_as_req
    svc
    iret

gp_mount:
    push r1
    push r2
    mov r1, 109
    call gp_perm_ok
    pop r2
    pop r1
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    stw [r4+0x0050], r1
    stw [r4+0x0052], r2
    mov r1, r1
    call gp_dev_code
    cmp r0, 0
    je gp_fail
    cmp r0, 254
    je gp_fail
    stw [r4+0x0056], r0
    mov r1, r0
    call vfs_setdev
    mov r1, 0
    call vfs_sector
    cmp r0, 0
    jne gp_fail
    mov r1, 0x0D00
    ldb r0, [r1+0]
    cmp r0, 67
    jne gp_fail
    ldb r0, [r1+1]
    cmp r0, 82
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0052]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    stw [r4+0x0060], r0
    ldw r5, [r4+0x0040]
    stw [r4+0x0062], r5
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 2
    jne gp_fail
    call gp_is_mount
    cmp r0, 0
    je gp_fail
    mov r4, 0x00C0
gp_mount_free:
    cmp r4, 0x00E0
    je gp_fail
    ldb r5, [r4+2]
    cmp r5, 0
    je gp_mount_slot
    add r4, 4
    jmp gp_mount_free
gp_mount_slot:
    mov r6, 0
    stw [r6+0x0064], r4
    ldw r5, [r6+0x0062]
    stb [r4+0], r5
    ldw r5, [r6+0x0060]
    stb [r4+1], r5
    ldw r5, [r6+0x0056]
    stb [r4+2], r5
    mov r1, r5
    call vfs_setdev
    mov r6, 0
    ldw r4, [r6+0x0064]
    ldw r5, [r6+0x0042]
    stb [r4+3], r5
    mov r0, 42
    svc
    mov r0, 0
    iret

; r1 = user device path. Returns sdX code, or 0.
gp_dev_code:
    call gp_last_slash
    cmp r0, 0
    je gp_dev_name
    add r0, 1
    mov r1, r0
gp_dev_name:
    uldb r3, [r1+0]
    cmp r3, 115
    jne gp_dev_no
    uldb r3, [r1+1]
    cmp r3, 100
    jne gp_dev_no
    uldb r3, [r1+2]
    cmp r3, 97
    jlt gp_dev_no
    cmp r3, 122
    jgt gp_dev_no
    uldb r4, [r1+3]
    cmp r4, 0
    jne gp_dev_no
    sub r3, 96
    mov r0, r3
    ret
gp_dev_no:
    mov r0, 0
    ret

gp_umount:
    push r1
    mov r1, 109
    call gp_perm_ok
    pop r1
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    stw [r4+0x0050], r1
    call gp_dev_code
    cmp r0, 0
    je gp_umount_path
    stw [r4+0x0056], r0
    jmp gp_umount_find
gp_umount_path:
    ldw r1, [r4+0x0050]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    ldw r5, [r4+0x0040]
    stw [r4+0x0056], r5
gp_umount_find:
    mov r4, 0x00C0
gp_umount_scan:
    cmp r4, 0x00E0
    je gp_fail
    ldb r5, [r4+2]
    mov r6, 0
    ldw r6, [r6+0x0056]
    cmp r5, r6
    je gp_umount_hit
    add r4, 4
    jmp gp_umount_scan
gp_umount_hit:
    ldb r6, [r4+2]
    mov r3, 0
gp_umount_busy:
    cmp r3, 16
    je gp_umount_clear
    mov r5, r3
    mul r5, 192
    add r5, 0x0100
    ldb r0, [r5+0]
    cmp r0, 1
    jne gp_umount_next
    ldb r0, [r5+1]
    cmp r0, 5
    je gp_umount_next
    ldb r0, [r5+22]
    cmp r0, r6
    je gp_fail
gp_umount_next:
    add r3, 1
    jmp gp_umount_busy
gp_umount_clear:
    mov r0, 0
    stb [r4+0], r0
    stb [r4+1], r0
    stb [r4+2], r0
    stb [r4+3], r0
    mov r0, 42
    svc
    mov r0, 0
    iret

gp_view:
    mov r4, 0
    ldw r1, [r4+0x0094]
    cmp r1, 1
    je gp_ps
    cmp r1, 2
    je gp_mem
    cmp r1, 3
    je gp_lsblk
    cmp r1, 4
    je gp_df
    cmp r1, 5
    je gp_dmesg
    cmp r1, 6
    je gp_hex
    cmp r1, 7
    je gp_od
    cmp r1, 9
    je gp_help
    jmp gp_fail

gp_help:
    mov r1, gp_help_text
    call gp_puts
    jmp gp_view_done

gp_ps:
    mov r1, gp_ps_hdr
    call gp_puts
    mov r6, 0
gp_ps_loop:
    cmp r6, 16
    je gp_view_done
    mov r5, r6
    mul r5, 192
    add r5, 0x0100
    ldb r0, [r5+0]
    cmp r0, 1
    jne gp_ps_next
    push r6
    push r5
    ldw r1, [r5+2]
    mov r2, 5
    mov r3, 0
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldw r1, [r5+4]
    mov r2, 5
    mov r3, 0
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldw r1, [r5+${PCB_EUID}]
    mov r2, 5
    mov r3, 0
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldb r1, [r5+1]
    call gp_ps_state
    pop r5
    push r5
    ldb r1, [r5+21]
    mov r2, 3
    mov r3, 0
    call view_num
    mov r0, 112
    call view_putc
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldw r1, [r5+153]
    mov r2, 4
    mov r3, 0
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    push r5
    mov r1, r5
    add r1, 106
    call gp_pcb_str
    pop r5
    ldb r0, [r5+1]
    cmp r0, 5
    jne gp_ps_nl
    mov r1, gp_defunct
    call gp_puts
gp_ps_nl:
    mov r0, 10
    call view_putc
    pop r6
gp_ps_next:
    add r6, 1
    jmp gp_ps_loop

gp_ps_state:
    cmp r1, 1
    jne gp_st2
    mov r1, gp_st_new
    jmp gp_puts
gp_st2:
    cmp r1, 2
    jne gp_st3
    mov r1, gp_st_ready
    jmp gp_puts
gp_st3:
    cmp r1, 3
    jne gp_st4
    mov r1, gp_st_run
    jmp gp_puts
gp_st4:
    cmp r1, 4
    jne gp_st5
    mov r1, gp_st_block
    jmp gp_puts
gp_st5:
    mov r1, gp_st_zombie
    jmp gp_puts

; r1 = PCB string field (length byte then bytes).
gp_pcb_str:
    ldb r3, [r1+0]
    add r1, 1
    mov r6, 0
gp_pcb_str_loop:
    cmp r6, r3
    je gp_pcb_str_done
    ldb r0, [r1+0]
    push r1
    push r3
    push r6
    call view_putc
    pop r6
    pop r3
    pop r1
    add r1, 1
    add r6, 1
    jmp gp_pcb_str_loop
gp_pcb_str_done:
    ret

gp_mem:
    mov r1, gp_mem_hdr
    call gp_puts
    mov r1, gp_total
    call gp_puts
    call gp_frames_used
    mov r1, r0
    mov r2, 10
    mov r3, 0
    call gp_frames_bytes
    call gp_frames_free
    mov r1, r0
    mov r2, 10
    mov r3, 0
    call gp_frames_bytes
    mov r1, gp_bytes_nl
    call gp_puts
    mov r6, 0
gp_mem_proc:
    cmp r6, 16
    je gp_view_done
    mov r5, r6
    mul r5, 192
    add r5, 0x0100
    ldb r0, [r5+0]
    cmp r0, 1
    jne gp_mem_next
    push r6
    mov r1, gp_pid_lbl
    call gp_puts
    ldw r1, [r5+2]
    mov r2, 5
    mov r3, 1
    push r5
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    mov r1, r5
    add r1, 89
    call gp_pcb_str
    mov r0, 32
    call view_putc
    ldb r1, [r5+21]
    mov r2, 3
    mov r3, 1
    call view_num
    mov r1, gp_pages_nl
    call gp_puts
    pop r6
gp_mem_next:
    add r6, 1
    jmp gp_mem_proc

gp_frames_used:
    mov r6, 0
    mov r7, 0
gp_fu_loop:
    cmp r6, 256
    je gp_fu_done
    mov r5, r6
    div r5, 8
    mov r4, r6
    mod r4, 8
    mov r3, 1
    shl r3, r4
    add r5, 0x00E0
    ldb r0, [r5+0]
    and r0, r3
    cmp r0, 0
    je gp_fu_next
    add r7, 1
gp_fu_next:
    add r6, 1
    jmp gp_fu_loop
gp_fu_done:
    mov r0, r7
    ret

gp_frames_free:
    call gp_frames_used
    mov r1, 256
    sub r1, r0
    mov r0, r1
    ret

; r1 = frame count. Prints count*256, or 65536 when the count is 256.
gp_frames_bytes:
    cmp r1, 256
    je gp_frames_all
    mul r1, 256
    mov r2, 10
    mov r3, 0
    jmp view_num
gp_frames_all:
    mov r1, gp_total
    jmp gp_puts

gp_puts:
gp_puts_loop:
    ldb r0, [r1+0]
    cmp r0, 0
    je gp_puts_done
    push r1
    call view_putc
    pop r1
    add r1, 1
    jmp gp_puts_loop
gp_puts_done:
    ret

gp_view_done:
    mov r4, 0
    ldw r2, [r4+0x0086]
    mov r3, 0
    ustb [r2+0], r3
    ldw r1, [r4+0x0088]
    mov r0, r2
    sub r0, r1
    iret

gp_read_wide:
    mov r4, 0
    stw [r4+0x0050], r5
    stw [r4+0x0052], r2
    stw [r4+0x0054], r3
    ldw r6, [r5+4]
    stw [r4+0x0056], r6
    ldb r1, [r5+1]
    call vfs_setdev
    mov r4, 0
    ldw r5, [r4+0x0050]
    ldb r1, [r5+2]
    call ino_in_range
    cmp r0, 0
    jne read_failed
    call vfs_inode
    cmp r0, 65280
    je read_failed
    mov r4, 0
    stw [r4+0x005A], r0
    mov r1, r0
    add r1, 2
    call vfs_u16
    cmp r0, 65535
    je read_failed
    mov r4, 0
    stw [r4+0x0058], r0
    ldw r6, [r4+0x0056]
    cmp r6, r0
    jlt gp_wide_have
    jmp read_eof
gp_wide_have:
    mov r7, r0
    sub r7, r6
    ldw r3, [r4+0x0054]
    cmp r3, 0
    jne gp_wide_max
    mov r3, r7
gp_wide_max:
    cmp r3, r7
    jlt gp_wide_cnt
    mov r3, r7
gp_wide_cnt:
    ldw r5, [r4+0x0042]
    mul r5, 256
    mov r1, r6
    div r1, r5
    mov r2, r6
    mod r2, r5
    stw [r4+0x005C], r1
    stw [r4+0x005E], r2
    mov r7, r2
    mod r7, 256
    mov r0, 256
    sub r0, r7
    cmp r3, r0
    jlt gp_wide_ok
    mov r3, r0
gp_wide_ok:
    stw [r4+0x0060], r3
    ldw r1, [r4+0x005A]
    add r1, 8
    ldw r2, [r4+0x005C]
    mul r2, 2
    add r1, r2
    call vfs_u16
    cmp r0, 0
    je read_failed
    cmp r0, 65535
    je read_failed
    mov r1, r0
    mov r4, 0
    ldw r5, [r4+0x0042]
    mul r1, r5
    ldw r2, [r4+0x005E]
    div r2, 256
    add r1, r2
    call vfs_sector
    cmp r0, 0
    jne read_failed
    mov r4, 0
    ldw r2, [r4+0x0052]
    ldw r3, [r4+0x0060]
    ldw r6, [r4+0x005E]
    mod r6, 256
    add r6, 0x0D00
    mov r7, 0
gp_wide_copy:
    cmp r7, r3
    je gp_wide_update
    ldb r1, [r6+0]
    ustb [r2+0], r1
    add r6, 1
    add r2, 1
    add r7, 1
    jmp gp_wide_copy
gp_wide_update:
    ldw r5, [r4+0x0050]
    ldw r6, [r4+0x0056]
    add r6, r3
    stw [r5+4], r6
    mov r0, r3
    iret

; r1 = physical address, r2 = count. Copies raw bytes into the view buffer.
gp_ncopy:
    cmp r2, 0
    je gp_ncopy_done
    ldb r0, [r1+0]
    push r1
    push r2
    call view_putc
    pop r2
    pop r1
    add r1, 1
    sub r2, 1
    jmp gp_ncopy
gp_ncopy_done:
    ret

; Device catalog at 0x1200, 8 records of 64 bytes. Host publishes facts only.
gp_lsblk:
    mov r1, gp_lsblk_hdr
    call gp_puts
    mov r6, 0
gp_lsblk_loop:
    cmp r6, 8
    je gp_view_done
    mov r5, r6
    mul r5, 64
    add r5, 0x1200
    ldb r0, [r5+0]
    cmp r0, 1
    jne gp_lsblk_next
    push r6
    push r5
    mov r1, r5
    add r1, 2
    mov r2, 3
    call gp_ncopy
    mov r2, 2
    call view_pad
    pop r5
    push r5
    mov r1, r5
    add r1, 6
    mov r2, 17
    call gp_ncopy
    pop r5
    push r5
    mov r1, r5
    add r1, 27
    mov r2, 6
    call gp_ncopy
    pop r5
    push r5
    mov r1, r5
    add r1, 33
    mov r2, 6
    call gp_ncopy
    mov r0, 32
    call view_putc
    pop r5
    push r5
    mov r1, r5
    add r1, 23
    ldb r2, [r5+5]
    call gp_ncopy
    mov r0, 32
    call view_putc
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldb r0, [r5+1]
    add r0, 48
    call view_putc
    mov r0, 32
    call view_putc
    pop r5
    mov r1, r5
    add r1, 44
    call gp_puts
    mov r0, 10
    call view_putc
    pop r6
gp_lsblk_next:
    add r6, 1
    jmp gp_lsblk_loop

gp_df:
    mov r1, gp_df_hdr
    call gp_puts
    mov r6, 0
gp_df_loop:
    cmp r6, 8
    je gp_view_done
    mov r5, r6
    mul r5, 64
    add r5, 0x1200
    ldb r0, [r5+0]
    cmp r0, 1
    jne gp_df_next
    push r6
    mov r1, gp_dev_prefix
    call gp_puts
    push r5
    mov r1, r5
    add r1, 2
    mov r2, 3
    call gp_ncopy
    mov r2, 4
    call view_pad
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldw r1, [r5+40]
    mov r2, 5
    mov r3, 0
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldw r1, [r5+42]
    mov r2, 4
    mov r3, 0
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldw r1, [r5+40]
    ldw r2, [r5+42]
    sub r1, r2
    mov r2, 5
    mov r3, 0
    call view_num
    mov r0, 32
    call view_putc
    pop r5
    push r5
    ldb r1, [r5+39]
    mov r2, 3
    mov r3, 0
    call view_num
    mov r0, 37
    call view_putc
    mov r0, 32
    call view_putc
    pop r5
    mov r1, r5
    add r1, 44
    call gp_puts
    mov r0, 10
    call view_putc
    pop r6
gp_df_next:
    add r6, 1
    jmp gp_df_loop

; kmsg lives at 0x0E00: u16 length, then text. The host only appends events.
gp_dmesg:
    mov r4, 0x0E00
    ldw r6, [r4+0]
    mov r5, 0x0E02
    mov r7, 0
gp_dmesg_loop:
    cmp r7, r6
    je gp_view_done
    cmp r7, 1190
    je gp_view_done
    ldb r0, [r5+0]
    push r5
    push r6
    push r7
    call view_putc
    pop r7
    pop r6
    pop r5
    add r5, 1
    add r7, 1
    jmp gp_dmesg_loop

; hexdump: resolve, require a regular file and read permission, format 256 B.
gp_hex:
    mov r4, 0
    ldw r1, [r4+0x0090]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0060], r0
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    stw [r4+0x0066], r0
    mov r1, r0
    call vfs_u8
    cmp r0, 1
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0060]
    mov r2, ${M_READ}
    mov r3, ${M_OREAD}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    ldw r1, [r4+0x0066]
    add r1, 2
    call vfs_u16
    cmp r0, 65535
    je gp_fail
    cmp r0, 256
    jlt gp_hex_size
    mov r0, 256
gp_hex_size:
    mov r4, 0
    stw [r4+0x0062], r0
    cmp r0, 0
    je gp_view_done
    ldw r1, [r4+0x0066]
    add r1, 8
    call vfs_u16
    cmp r0, 0
    je gp_fail
    cmp r0, 65535
    je gp_fail
    mov r1, r0
    mov r4, 0
    ldw r2, [r4+0x0042]
    mul r1, r2
    call vfs_sector
    cmp r0, 0
    jne gp_fail
    mov r4, 0
    mov r0, 0
    stw [r4+0x0064], r0
gp_hex_row:
    mov r4, 0
    ldw r1, [r4+0x0086]
    ldw r2, [r4+0x0088]
    sub r1, r2
    cmp r1, 1100
    jgt gp_view_done
    ldw r6, [r4+0x0064]
    ldw r7, [r4+0x0062]
    cmp r6, r7
    jlt gp_hex_have
    jmp gp_view_done
gp_hex_have:
    mov r5, 6
gp_hex_z:
    mov r0, 48
    push r5
    call view_putc
    pop r5
    sub r5, 1
    cmp r5, 0
    jne gp_hex_z
    mov r4, 0
    ldw r0, [r4+0x0064]
    call gp_hexbyte
    mov r0, 32
    call view_putc
    mov r0, 32
    call view_putc
    mov r4, 0
    mov r0, 0
    stw [r4+0x0068], r0
gp_hex_h:
    mov r4, 0
    ldw r5, [r4+0x0068]
    cmp r5, 16
    je gp_hex_bar
    ldw r6, [r4+0x0064]
    add r6, r5
    ldw r7, [r4+0x0062]
    cmp r6, r7
    jlt gp_hex_hb
    mov r0, 32
    call view_putc
    mov r0, 32
    call view_putc
    mov r0, 32
    call view_putc
    jmp gp_hex_hn
gp_hex_hb:
    add r6, 0x0D00
    ldb r0, [r6+0]
    call gp_hexbyte
    mov r0, 32
    call view_putc
gp_hex_hn:
    mov r4, 0
    ldw r5, [r4+0x0068]
    add r5, 1
    stw [r4+0x0068], r5
    jmp gp_hex_h
gp_hex_bar:
    mov r0, 124
    call view_putc
    mov r4, 0
    mov r0, 0
    stw [r4+0x0068], r0
gp_hex_a:
    mov r4, 0
    ldw r5, [r4+0x0068]
    cmp r5, 16
    je gp_hex_end
    ldw r6, [r4+0x0064]
    add r6, r5
    ldw r7, [r4+0x0062]
    cmp r6, r7
    jlt gp_hex_ac
    jmp gp_hex_end
gp_hex_ac:
    add r6, 0x0D00
    ldb r0, [r6+0]
    cmp r0, 32
    jlt gp_hex_dot
    cmp r0, 127
    jlt gp_hex_ap
gp_hex_dot:
    mov r0, 46
gp_hex_ap:
    call view_putc
    mov r4, 0
    ldw r5, [r4+0x0068]
    add r5, 1
    stw [r4+0x0068], r5
    jmp gp_hex_a
gp_hex_end:
    mov r0, 124
    call view_putc
    mov r0, 10
    call view_putc
    mov r4, 0
    ldw r6, [r4+0x0064]
    add r6, 16
    stw [r4+0x0064], r6
    jmp gp_hex_row

; r0 = byte. Prints two lowercase hex digits.
gp_hexbyte:
    mov r4, 0
    stw [r4+0x007A], r0
    shr r0, 4
    call gp_hexdig
    mov r4, 0
    ldw r0, [r4+0x007A]
    and r0, 15
gp_hexdig:
    cmp r0, 10
    jlt gp_hexdig_d
    add r0, 87
    jmp view_putc
gp_hexdig_d:
    add r0, 48
    jmp view_putc

; objdump: guest checks the path and read permission, host decodes with isa.ts.
gp_od:
    mov r4, 0
    ldw r1, [r4+0x0090]
    call vfs_resolve
    cmp r0, 65535
    je gp_fail
    mov r4, 0
    stw [r4+0x0060], r0
    mov r1, r0
    call vfs_inode
    cmp r0, 65280
    je gp_fail
    mov r1, r0
    call vfs_u8
    cmp r0, 1
    jne gp_fail
    mov r4, 0
    ldw r1, [r4+0x0060]
    mov r2, ${M_READ}
    mov r3, ${M_OREAD}
    call vfs_may
    cmp r0, 0
    jne gp_fail
    mov r1, gp_od_req
    mov r4, 0
    ldw r5, [r4+0x0040]
    stb [r1+0], r5
    ldw r5, [r4+0x0060]
    stb [r1+1], r5
    ldw r5, [r4+0x0088]
    stw [r1+2], r5
    ldw r5, [r4+0x0090]
    stw [r1+4], r5
    mov r0, 45
    mov r1, gp_od_req
    svc
    iret

.data
pathbuf:
    .space 80
gp_slot:
    .space 16
gp_ent:
    .space 16
gp_names:
    .space 128
spawn_req:
    .space 272
gp_as_req:
    .space 4
gp_od_req:
    .space 8
gp_lsblk_hdr:
    .asciz "NAME MODEL             SIZE  USED  BS  RM MOUNTPOINT\\n"
gp_df_hdr:
    .asciz "Filesystem Blocks Used Avail Use% Mounted on\\n"
gp_dev_prefix:
    .asciz "/dev/"
gp_bin:
    .asciz "/bin/"
gp_usr:
    .asciz "/usr/bin/"
gp_root_env:
    .ascii "USER\\0root\\0HOME\\0/root\\0PATH\\0/bin:/usr/bin\\0SHELL\\0/bin/sh\\0"
    .byte 0
gp_ps_hdr:
    .asciz "  PID  PPID   UID STAT MEM TIME COMMAND\\n"
gp_st_new:
    .asciz "NEW  "
gp_st_ready:
    .asciz "READ "
gp_st_run:
    .asciz "RUNN "
gp_st_block:
    .asciz "BLOC "
gp_st_zombie:
    .asciz "ZOMB "
gp_defunct:
    .asciz " <defunct>"
gp_mem_hdr:
    .asciz "             total      used      free\\nMem:  "
gp_total:
    .asciz "     65536"
gp_bytes_nl:
    .asciz " bytes\\n"
gp_pid_lbl:
    .asciz "pid "
gp_pages_nl:
    .asciz " pages\\n"
gp_help_text:
    .ascii "crados commands (every file in /bin is CRX machine code)\\n\\n"
    .ascii "files:   ls [-l] cat head wc cp mv rm rmdir mkdir touch chmod chown echo\\n"
    .ascii "process: ps kill sleep count pid\\n"
    .ascii "storage: lsblk df mount umount   (writeback is automatic)\\n"
    .ascii "account: login su passwd useradd userdel users chperm\\n"
    .ascii "kernel:  mem dmesg hexdump objdump uname whoami\\n"
    .ascii "build:   as source.s -o program\\n"
    .ascii "shell:   cd pwd clear exit; > redirects; & runs in background\\n"
    .ascii "manual:  man [README|asm|storage|inspect|script|accounts]\\n"
    .asciz "         append .zh for Chinese, e.g. man asm.zh\\n"
`
