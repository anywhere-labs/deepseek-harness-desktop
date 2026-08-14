# Agent Note: 保留桌面 Host 运行期输出

Status: implemented

[English](2026-08-15-preserve-desktop-host-runtime-output.md) | 中文

## Problem

桌面端 supervisor 从 Host 的规范 stdout 行识别回环 URL，随后完成启动。相同的就绪清理还会解除 stdout 与 stderr 的数据订阅。移除数据监听器后，Node 可读流仍保持流动，因此此后的每个 Host 分片都会被丢弃，无法进入桌面端诊断。运行时警告和失败详情在启动后不可见，最终只剩退出码与信号。

## Decision

supervisor 在两条 Host 输出流的整个生命周期内保留订阅。每个 stdout 和 stderr 分片都会进入已配置的诊断回调。stdout 处理器只在启动结算前查询就绪解析器，就绪清理只负责超时计时器。有界的近期输出尾段继续用于启动失败消息。

## Alternatives considered

**就绪后停止消费输出。** 拒绝，因为 Host 是桌面端自有子进程，其警告与错误是诊断启动后故障的主要信息。

**继续让 stdout 经过就绪解析器。** 拒绝，因为此后类似另一个就绪 URL 的日志行不能把普通运行时输出变成启动冲突，也不能终止已经就绪的 Host。

**把 Host 输出持久化到专用日志文件。** 暂缓，因为持久化需要确定保留、轮转与隐私策略。保留现有诊断回调即可修复输出丢失，同时不增加持久产物。

## Consequences

Host 输出在整个运行期间都可通过桌面进程观察，而就绪流程仍只接受第一个有效回环 URL。高吞吐 Host 输出会进入现有诊断接收端，但 supervisor 为启动失败保留的上下文仍有界。单元覆盖固定了就绪后的 stdout 与 stderr 转发，并证明后续形似就绪信息的输出只会被记录，不会再次解析。
