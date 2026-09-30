# script

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
