; A tiny SNES program whose memory, picture, and sound
; react to the joypad in simple, predictable ways.
; Assembled by test/smoke.mjs with ca65 and ld65 (from cc65).
;
; Every frame, during vblank, it:
;   - stores the joypad word ($4218) at $7E0010,
;     counts frames at $7E0012 and new presses of B at $7E0014;
;   - sets the backdrop color (the only thing on screen):
;     A adds full red, X full green, and Y full blue.
;     The color window blacks out x < 64 and x > 191,
;     so only the middle half of each line shows the color;
;   - plays a looping square wave on DSP voice 0 while B is held:
;     16 samples per period at the DSP's 32 kHz, so about 2 kHz,
;     or about 4 kHz while Up is also held.
;
; The sound chip runs a small SPC700 program (spc_program below),
; uploaded through the IPL boot ROM,
; that copies (register, value) pairs from the CPU into DSP registers.

.p816
.smart -

joy     = $10   ; word: joypad bits as read from $4218
frames  = $12   ; word: frames since start
presses = $14   ; word: new presses of B
prev    = $16   ; word: last frame's joypad bits
seq     = $18   ; byte: last sequence number sent to the SPC700
color   = $1A   ; word: backdrop color (BGR555)

; Joypad bits ($4218 word)
JOY_B  = $8000
JOY_Y  = $4000
JOY_UP = $0800
JOY_A  = $0080
JOY_X  = $0040

.segment "CODE"

reset:
  sei
  clc
  xce               ; native mode
  rep #$38          ; 16-bit A, X, Y; binary mode
  .a16
  .i16
  ldx #$1FFF
  txs
  lda #$0000
  tcd               ; direct page = $0000
  sep #$20          ; 8-bit A
  .a8
  .i16
  pha
  plb               ; data bank = $00

  lda #$80
  sta $2100         ; force blank while setting up
  stz $4200         ; no NMI or auto joypad read yet

  ; Clear our variables ($00-$FF of work RAM).
  ldx #$00FE
: stz $00,x
  stz $01,x
  dex
  dex
  bpl :-

  ; Nothing on the main or sub screen: only the backdrop shows.
  stz $212C
  stz $212D
  stz $2121
  stz $2122
  stz $2122         ; backdrop color = black

  ; Color window 1 covers x = 64..191.
  ; Outside it, colors are clipped to black.
  lda #64
  sta $2126         ; WH0
  lda #191
  sta $2127         ; WH1
  lda #$20
  sta $2125         ; WOBJSEL: color window uses window 1
  lda #$40
  sta $2130         ; CGWSEL: clip to black outside the color window
  stz $2131         ; CGADSUB: no color math

  jsr spc_upload

  ; Set up the DSP.
  ldy #$0000
: ldx dsp_init,y
  jsr dsp_write
  iny
  iny
  cpy #dsp_init_end - dsp_init
  bne :-

  lda #$0F
  sta $2100         ; screen on, full brightness
  lda #$81
  sta $4200         ; NMI and auto joypad read on

forever:
  wai
  bra forever

nmi:
  rep #$30
  .a16
  pha
  phx
  phy
  sep #$20
  .a8
  lda $4210         ; acknowledge the NMI

: lda $4212         ; wait for the auto joypad read to finish
  and #$01
  bne :-

  rep #$20
  .a16
  lda $4218
  sta joy
  inc frames

  ; Backdrop color from A, X, and Y.
  stz color
  lda #JOY_A
  bit joy
  beq :+
  lda #$001F
  tsb color
: lda #JOY_X
  bit joy
  beq :+
  lda #$03E0
  tsb color
: lda #JOY_Y
  bit joy
  beq :+
  lda #$7C00
  tsb color
:
  sep #$20
  .a8
  stz $2121
  lda color
  sta $2122
  lda color+1
  sta $2122

  ; Sound: key voice 0 on when B is pressed, off when released.
  lda joy+1
  eor prev+1
  and #>JOY_B
  beq @pitch
  lda joy+1
  bmi @press
  ldx #$015C        ; KOFF = 1
  jsr dsp_write
  bra @pitch
@press:
  ldx #$005C        ; KOFF = 0
  jsr dsp_write
  ldx #$014C        ; KON = 1
  jsr dsp_write
  rep #$20
  inc presses
  sep #$20

@pitch:
  ; Voice 0 pitch: $1000 (one sample per DSP sample), or $2000 with Up.
  ldx #$1003
  lda joy+1
  and #>JOY_UP
  beq :+
  ldx #$2003
: jsr dsp_write

  rep #$20
  .a16
  lda joy
  sta prev

  rep #$30
  ply
  plx
  pla
  rti

  .a8
  .i16

; Upload spc_image to SPC700 RAM at $0200 and start it there,
; using the IPL boot ROM's transfer protocol.
spc_upload:
  ldx #$BBAA
: cpx $2140         ; wait for the IPL ROM to be ready
  bne :-
  ldx #$0200
  stx $2142         ; destination
  lda #$01
  sta $2141         ; nonzero: a block of data follows
  lda #$CC
  sta $2140
: cmp $2140
  bne :-

  ldy #$0000
@byte:
  lda spc_image,y
  sta $2141
  tya
  sta $2140         ; index of this byte (low 8 bits)
: cmp $2140
  bne :-
  iny
  cpy #spc_image_end - spc_image
  bne @byte

  ldx #$0200
  stx $2142         ; entry point
  stz $2141         ; zero: jump to the entry point
  tya
  inc a             ; last index + 2, never 0
  bne :+
  inc a
: sta $2140
: cmp $2140
  bne :-
  sta seq           ; the SPC700 program starts from this value
  rts

; Write one DSP register: X = value << 8 | register.
dsp_write:
  stx $2141         ; register to port 1, value to port 2
  lda seq
  inc a
  sta seq
  sta $2140         ; a new sequence number tells the SPC700 to copy them
: cmp $2140         ; it echoes the number back when done
  bne :-
  rts

irq:
  rti

.segment "RODATA"

; DSP setup, as (register, value) pairs.
dsp_init:
  .byte $6C, $20    ; FLG: not reset, not muted, no echo writes
  .byte $0C, $7F    ; main volume left
  .byte $1C, $7F    ; main volume right
  .byte $2C, $00    ; echo volume left
  .byte $3C, $00    ; echo volume right
  .byte $4D, $00    ; no echo
  .byte $3D, $00    ; no noise
  .byte $2D, $00    ; no pitch modulation
  .byte $5D, $03    ; sample directory at $0300
  .byte $00, $7F    ; voice 0 volume left
  .byte $01, $7F    ; voice 0 volume right
  .byte $02, $00    ; voice 0 pitch, low
  .byte $03, $10    ; voice 0 pitch, high ($1000)
  .byte $04, $00    ; voice 0 sample 0
  .byte $05, $00    ; voice 0 ADSR off: use GAIN
  .byte $07, $7F    ; voice 0 GAIN: fixed, full
  .byte $5C, $00    ; KOFF: no voice keyed off
dsp_init_end:

; SPC700 RAM image, loaded at $0200.
spc_image:
  ; $0200: wait for a new sequence number on port 0,
  ; then write port 2 into the DSP register named by port 1,
  ; and echo the sequence number back on port 0.
  .byte $E4, $F4        ; $0200        mov a, $F4
  .byte $C4, $00        ; $0202        mov $00, a
  .byte $E4, $F4        ; $0204 loop:  mov a, $F4
  .byte $64, $00        ; $0206        cmp a, $00
  .byte $F0, $FA        ; $0208        beq loop
  .byte $C4, $00        ; $020A        mov $00, a
  .byte $FA, $F5, $F2   ; $020C        mov $F2, $F5
  .byte $FA, $F6, $F3   ; $020F        mov $F3, $F6
  .byte $C4, $F4        ; $0212        mov $F4, a
  .byte $2F, $EE        ; $0214        bra loop
  .res $0300 - $0216
  ; $0300: sample directory: sample 0 starts and loops at $0400.
  .word $0400, $0400
  .res $0400 - $0304
  ; $0400: one BRR block, end + loop: a square wave,
  ; 8 samples of +7 and 8 of -8 at shift 10.
  ; (At shift 12, the DSP's interpolation overflows
  ; and the negative half comes out positive.)
  .byte $A3
  .byte $77, $77, $77, $77, $88, $88, $88, $88
spc_image_end:

.segment "HEADER"
  .byte "LIBRETRO-WASM TEST   "  ; title, 21 bytes
  .byte $20         ; LoROM, slow
  .byte $00         ; ROM only
  .byte $05         ; 32 KiB
  .byte $00         ; no cartridge RAM
  .byte $01         ; North America (NTSC)
  .byte $00         ; developer
  .byte $00         ; version
  .word $FFFF       ; checksum complement (set by the test)
  .word $0000       ; checksum (set by the test)

.segment "VECTORS"
  ; Native mode
  .word 0, 0        ; unused
  .word irq         ; COP
  .word irq         ; BRK
  .word irq         ; ABORT
  .word nmi         ; NMI
  .word 0           ; unused
  .word irq         ; IRQ
  ; Emulation mode
  .word 0, 0        ; unused
  .word irq         ; COP
  .word 0           ; unused
  .word irq         ; ABORT
  .word nmi         ; NMI
  .word reset       ; RESET
  .word irq         ; IRQ/BRK
