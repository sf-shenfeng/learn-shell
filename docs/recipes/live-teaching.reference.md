<!-- recipe_version: aa5083618eae · generated_at: 2026-07-22 · canonical: recipe://live-teaching.reference -->
本册是 live-teaching 的参考卷:事故史/设计解释/示例。执行规则以 quick 卷为准。

## 值更契约 v3 —— 参考实现(非规范):看门脚本

下面这套是"有后台阻塞能力"环境下的一种可抄写法,不是唯一合法路径。你家
harness 用自家机制达标,同样合法,不必比照本节改造。

`apps/server/scripts/live-watch.py` 把等待封装成**一次阻塞的工具调用**
(替你每 30s 打心跳保在线灯常亮,同时挂在 `/bridge/wait` 长轮询上等事件):
```
loop:
  python3 live-watch.py --base-url ... --pair-id ...   ← 阻塞,零 token
    退出码 0 = 事件到达(stdout 一行 JSON);退出码 2 = 续挂时限到,直接再挂
  读事件 → 出下一个 move(live_message_send)→ 回到 loop
```
脚本内嵌 2026-07 三代桥事故的六条军规(JSON 不过 shell/先送达后推进游标/
id 去重/禁代理/上岗先验结构/锚失 fail-closed)——抄它就照抄语义,别自己
手搓劣化版。

## 运行环境适配(诚实边界) —— 唤醒语义三层(host taxonomy)

三层各司其职,不许越权代岗:**watcher**——接事件那一下;**supervisor/spool**——
事件不丢,进程会重启;**wake primitive**——让已经结束 turn 的 agent 真正回来
干活。前两层全绿而第三层缺席,是最危险的绿灯:事件都在,没人回来读。

## 运行环境适配 —— 没有后台唤醒原语的宿主:参考实现细节

one-shot 型 harness 的问题:看门脚本收到事件、正常退出后,宿主没有机制把
已经结束的模型回合重新叫起来读那行 stdout——480s 时限到、退出码 2 续挂
同样没人接手。

参考实现另加一层外壳 `apps/server/scripts/live-watch-supervisor.py`——
常驻循环里反复起 `live-watch.py`,退出码 0/2 都立即重挂,事件那行 JSON
顺手落进本地 spool 文件(`~/.cache/ls-live-watch/spool-<pair>-<日期>.ndjson`,
按天滚动、supervisor 永不主动删,旧文件 7 天自清)。你在自己回合边界
(不是被唤醒,是原本就在进行的一轮)廉价瞄一眼 spool 有没有新行,处理完
记一下 offset,下次接着读。这仍然只是"方法自由"里的一种可抄写法,不是
规范——你家 harness 如果有别的机制能同时做到"事件不丢、agent 不用背轮询
骂名",不必比照本节改造。

🖤
