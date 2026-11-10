# -*- coding: utf-8 -*-
"""
体感模仿 - 设备端（USB 有线版）

通过 USB 串口接收网页端发来的指令，机器人像照镜子一样【镜像】模仿人的动作。
- 人举左手 → 机器人举右臂
- 人举右手 → 机器人举左臂
- 人双手举起 → 机器人双臂举起
- 人双手放下 → 机器人双臂放下
- 人头左转 → 机器人头右转
- 人头右转 → 机器人头左转
- 人左手平举 → 机器人右转（原地）
- 人右手平举 → 机器人左转（原地）

网页通过 Web Serial（USB 数据线）连接本设备，指令格式：
- "ARM:left:right\n"  — 手臂，1=举起 0=放下
- "HEAD:LEFT|RIGHT|CENTER\n"  — 头部朝向
- "TURN:LEFT|RIGHT|STOP\n"  — 底盘转向

接线：左手 -> B 口，右手 -> A 口，头部 -> C 口，左履带 -> F 口，右履带 -> E 口
注意：转向为持续运动，设备端带看门狗，超时无指令自动停履带。

防卡死设计（保证可注入、可长期运行）：
1. stdin 按字节非阻塞读取并自行拼行，不用 readline()——避免主机
   数据缺换行符时整个主循环永久阻塞（卡死主循环会让看门狗失效、
   履带一直转）；
2. 所有 print 包裹异常保护——主机拔线后写串口可能抛异常；
3. 主循环可被 Ctrl-C 打断（网页注入脚本前会先发 Ctrl-C 停掉本程序）。
"""

import sys
import time

try:
    import select
except ImportError:
    select = None

import r2
from r2_encoder_motor import EncoderMotor

# ---------------- 硬件配置 ----------------
HEAD_PORT = 'C'
HEAD_CENTER_ANGLE = 0
HEAD_LEFT_ANGLE = 60
HEAD_RIGHT_ANGLE = 300
HEAD_SPEED = 50

LEFT_ARM_PORT = 'B'
RIGHT_ARM_PORT = 'A'
LEFT_ARM_DOWN_ANGLE = 0
LEFT_ARM_UP_ANGLE = 270
RIGHT_ARM_DOWN_ANGLE = 0
RIGHT_ARM_UP_ANGLE = 90
ARM_SPEED = 50

# 履带（底盘转向）：左履带 -> F 口，右履带 -> E 口
TRACK_LEFT_PORT = 'F'
TRACK_RIGHT_PORT = 'E'
TRACK_LEFT_FORWARD_DIR = 0
TRACK_RIGHT_FORWARD_DIR = 1
TURN_SPEED = 40

# 看门狗：超过该秒数没收到任何指令，自动停履带（防断连后一直转）
CMD_TIMEOUT_MS = 1500

# ---------------- 状态 ----------------
current_left = False
current_right = False
current_head = 'CENTER'
current_turn = 'STOP'
last_cmd_ms = 0


def safe_print(text):
    try:
        print(text)
    except Exception:
        pass


def make_stdin_poller():
    if select is None:
        return None
    try:
        poller = select.poll()
        poller.register(sys.stdin, select.POLLIN)
        return poller
    except Exception:
        return None


class HostLineReader:
    """非阻塞读取主机指令并自行拼行。

    不使用 sys.stdin.readline()：poll(0) 只保证“至少有 1 个字节”，
    如果主机发来的行丢了换行符（串口 RX 缓冲溢出丢字节时可能发生），
    readline() 会永久阻塞，整个主循环随之卡死——履带看门狗也停摆。
    这里只在 poll 报告可读时读 1 个字节，凑成完整行才上抛，
    凑不成就留在缓冲区等待。
    """

    MAX_LINE_BYTES = 128

    def __init__(self, poller):
        self.poller = poller
        self.buf = ""

    def drain(self):
        lines = []
        while self._readable():
            try:
                ch = sys.stdin.read(1)
            except Exception:
                break
            if not ch:
                break
            if ch == "\n":
                line = self.buf.strip()
                self.buf = ""
                if line:
                    lines.append(line)
                continue
            self.buf += ch
            if len(self.buf) > self.MAX_LINE_BYTES:
                # 一直没有换行符的超长输入按垃圾丢弃，防止缓冲无限增长。
                self.buf = ""
        return lines

    def _readable(self):
        if self.poller is None:
            return False
        try:
            return bool(self.poller.poll(0))
        except Exception:
            return False


def apply_head(direction):
    global current_head
    if direction == current_head:
        return
    current_head = direction
    # 镜像：人头左转 → 机器人头右转（用对侧角度）
    if direction == 'LEFT':
        head.to_angle(HEAD_RIGHT_ANGLE, HEAD_SPEED, 2, True)
        safe_print("头右转（镜像人左转）")
    elif direction == 'RIGHT':
        head.to_angle(HEAD_LEFT_ANGLE, HEAD_SPEED, 2, True)
        safe_print("头左转（镜像人右转）")
    else:
        head.to_angle(HEAD_CENTER_ANGLE, HEAD_SPEED, 2, True)
        safe_print("头居中")


def apply_command(cmd):
    global current_left, current_right
    parts = cmd.split(':')
    if len(parts) != 2:
        return

    # 镜像：parts[0]=人左手 parts[1]=人右手，机器人像照镜子一样用对侧手臂
    robot_left_up = parts[1] == '1'   # 机器人左臂 ← 人的右手
    robot_right_up = parts[0] == '1'  # 机器人右臂 ← 人的左手

    if robot_left_up != current_left:
        current_left = robot_left_up
        if robot_left_up:
            left_arm.to_angle(LEFT_ARM_UP_ANGLE, ARM_SPEED, 2, True)
            safe_print("左臂举起")
        else:
            left_arm.to_angle(LEFT_ARM_DOWN_ANGLE, ARM_SPEED, 2, True)
            safe_print("左臂放下")

    if robot_right_up != current_right:
        current_right = robot_right_up
        if robot_right_up:
            right_arm.to_angle(RIGHT_ARM_UP_ANGLE, ARM_SPEED, 2, True)
            safe_print("右臂举起")
        else:
            right_arm.to_angle(RIGHT_ARM_DOWN_ANGLE, ARM_SPEED, 2, True)
            safe_print("右臂放下")


def apply_turn(direction):
    """底盘原地转向：LEFT / RIGHT / STOP。两条履带反向转即原地打转。
    镜像：人左手平举(TURN:LEFT) → 机器人右转；人右手平举(TURN:RIGHT) → 机器人左转。"""
    global current_turn
    if direction == current_turn:
        return
    current_turn = direction
    if direction == 'LEFT':
        # 镜像 → 机器人右转
        track_left.start(TRACK_LEFT_FORWARD_DIR, TURN_SPEED)
        track_right.start(1 - TRACK_RIGHT_FORWARD_DIR, TURN_SPEED)
        safe_print("右转（镜像人左手平举）")
    elif direction == 'RIGHT':
        # 镜像 → 机器人左转
        track_left.start(1 - TRACK_LEFT_FORWARD_DIR, TURN_SPEED)
        track_right.start(TRACK_RIGHT_FORWARD_DIR, TURN_SPEED)
        safe_print("左转（镜像人右手平举）")
    else:
        track_left.stop()
        track_right.stop()
        safe_print("停止转向")


def parse_line(line):
    global last_cmd_ms
    line = line.strip()
    if not line:
        return
    last_cmd_ms = time.ticks_ms()  # 收到任何有效行都喂狗
    if 'HEAD:' in line:
        parts = line.split('HEAD:')
        for part in parts:
            part = part.strip()
            if part in ('LEFT', 'RIGHT', 'CENTER'):
                apply_head(part)
                safe_print("ACK:HEAD")
    if 'ARM:' in line:
        parts = line.split('ARM:')
        for part in parts:
            part = part.strip()
            if part and ':' in part:
                apply_command(part)
                safe_print("ACK:ARM")
    if 'TURN:' in line:
        parts = line.split('TURN:')
        for part in parts:
            part = part.strip()
            if part in ('LEFT', 'RIGHT', 'STOP'):
                apply_turn(part)
                safe_print("ACK:TURN")


# ---------------- 初始化 ----------------
head = EncoderMotor(HEAD_PORT)
head.reset(0)
head.to_angle(HEAD_CENTER_ANGLE, HEAD_SPEED, 2, True)

left_arm = EncoderMotor(LEFT_ARM_PORT)
left_arm.reset(0)
left_arm.to_angle(LEFT_ARM_DOWN_ANGLE, ARM_SPEED, 2, True)

right_arm = EncoderMotor(RIGHT_ARM_PORT)
right_arm.reset(0)
right_arm.to_angle(RIGHT_ARM_DOWN_ANGLE, ARM_SPEED, 2, True)

track_left = EncoderMotor(TRACK_LEFT_PORT)
track_right = EncoderMotor(TRACK_RIGHT_PORT)
track_left.stop()
track_right.stop()

r2.matrix_clear()
r2.matrix_show_light_effect(7, is_async=True, play_round=255)

safe_print("初始化完成，等待连接（USB 有线）…")
safe_print("网页连接后，人举手机器人跟着举手。")

host = HostLineReader(make_stdin_poller())
last_cmd_ms = time.ticks_ms()

try:
    while True:
        for line in host.drain():
            parse_line(line)
        # 看门狗：正在转向但超时没收到新指令，强制停履带（防断连后一直转）
        if current_turn != 'STOP' and time.ticks_diff(time.ticks_ms(), last_cmd_ms) > CMD_TIMEOUT_MS:
            apply_turn('STOP')
            safe_print("看门狗超时，已停止转向")
        time.sleep_ms(5)
except KeyboardInterrupt:
    track_left.stop()
    track_right.stop()
    left_arm.to_angle(LEFT_ARM_DOWN_ANGLE, ARM_SPEED, 2, True)
    right_arm.to_angle(RIGHT_ARM_DOWN_ANGLE, ARM_SPEED, 2, True)
    r2.matrix_clear()
    safe_print("程序已停止。")
