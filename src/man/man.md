# man

Every page is a plain text file stored in /usr/man, one folder for the
manuals and nothing else. `man page` opens page.md; `man page.zh` opens
page.zh.md. With no argument man prints this catalog.

## Pages

    README        what this system is, first steps, experiments
    asm           the CRX instruction set, the assembler, syscalls
    storage       disks, the on-disk format, writeback
    inspect       memory, the process table, registers
    script        shell scripts and the #! mechanism
    man           this catalog

## Reading them elsewhere

The pages are ordinary files, so everything works on them: cat, cp onto
a removable disk, hexdump. The host keeps the sources in one folder and
installs them into /usr/man at power-on.
