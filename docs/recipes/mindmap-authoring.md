<!-- recipe_version: bcc11cb36321 · generated_at: 2026-07-28 · canonical: recipe://mindmap-authoring -->
# Recipe · 画一张渲染得好的课程脑图

> 给任何要调 `add_mindmap_seed` 的 agent。一页读完,照做就能在 Learn Shell 的渲染层上得到一张干净的图。定位先记住:**这张图是老师的结构主张、学生的反刍底稿——不是自由绘图。**
>
> 先过裁量关(脑图裁量条款,2026-07-21):**脑图种子为可选教具,默认不生成。** 仅当空间关系、因果关系或分支结构确实比文字更清楚时才生成(判断权归老师)。不为教具齐整而出图——不能改变学习者动作的教具,最先接受削减。过了这一关,再往下读怎么画好。

## 1. 字段合同(写入时服务端强制,错了会被打回)

- 每个节点:`{id, title, level, pos_x, pos_y, is_expanded, sort_order}`,非 root 节点必带 `parent_id`
- `level` ∈ `root / branch / detail / note`
- 每条 link:`{id, from_node_id, to_node_id}`,外加**可选**的 `label`——跨分支联想那根虚线上写一句"为什么连"的自由标签,想留就留,不留也对
- **禁用** `source`、`target`——那是通用图方言的端点字段名,这里端点只认 `from_node_id`/`to_node_id`

## 2. 结构(树,不是链,不是伞)

- **树住 `parent_id` 里**;渲染器由它画实线层级。`links` 只用于**跨分支联想**(虚线)——把父子关系抄进 links 会导致每条关系画两遍。多数图 `links: []` 即正确。
- root 1 个 → branch **3-4 个** → 每支 detail 2-4 个,最深 3 层。
- **每个 branch 的标题必须说得出主张**(语义家族/对比/因果链/层级),不许是"其他"或对内容清单的复读。如果整张图和课文里的列表同构(root→每项一根辐条),这张图不配存在——删掉或重想组织原则。
- **不许成链**:连续独子(A→B→C→D 每层只有一个孩子)是病,那是大纲不是图。
- `note` 节点是一口气的旁注:**标题 ≤12 字**。需要一句话的洞见写进课文,不要挂在图上。

## 3. 布局(渲染是静态的,坐标你手工摆)

课文页嵌入图是 3:1 宽画布,**渲染时隐藏 root 及其连线**(页面标题已有课名),所以:

- `pos_x`/`pos_y` 用 0-100 百分比;全部落在 **x 8-92 / y 12-95** 内
- root 放天窗位 **(50, 8)**——全屏页会显示它,嵌入页看不见它
- 3 个分支簇按画布三等分排开(x≈8-30 / 38-62 / 70-92),4 支就四等分
- 分支标题在簇顶,子节点纵向展开,**同级 y 间距 ≥14**
- 防重叠估宽:中文字 ≈2.2 个 x 点,英文字母 ≈0.9 个 x 点——按 title 长度留横向净空
- `is_expanded` 全部 `true`,`sort_order` 按簇内顺序编号

## 4. 最小合法示例(3 支 × 各 1 子,可直接仿写)

```json
{"nodes":[
 {"id":"n_root","title":"课程主题","level":"root","pos_x":50,"pos_y":8,"is_expanded":true,"sort_order":0},
 {"id":"n_b1","title":"分支一:说出主张","level":"branch","pos_x":19,"pos_y":24,"is_expanded":true,"sort_order":1,"parent_id":"n_root"},
 {"id":"n_b1a","title":"要点 A","level":"detail","pos_x":19,"pos_y":40,"is_expanded":true,"sort_order":1,"parent_id":"n_b1"},
 {"id":"n_b2","title":"分支二:另一个主张","level":"branch","pos_x":50,"pos_y":24,"is_expanded":true,"sort_order":2,"parent_id":"n_root"},
 {"id":"n_b2a","title":"要点 B","level":"detail","pos_x":50,"pos_y":40,"is_expanded":true,"sort_order":2,"parent_id":"n_b2"},
 {"id":"n_b3","title":"分支三:第三个主张","level":"branch","pos_x":81,"pos_y":24,"is_expanded":true,"sort_order":3,"parent_id":"n_root"},
 {"id":"n_b3a","title":"要点 C","level":"detail","pos_x":81,"pos_y":40,"is_expanded":true,"sort_order":3,"parent_id":"n_b3"}
],"links":[]}
```

## 4½. 画完还能改 —— `update_mindmap_seed`

拓扑不再一锤定音。验尺或复盘发现结构没想透(分支切错、连了父子复印件、成了链),用 `update_mindmap_seed({ mindmap_id, content })` 改,不必删图重建:

- `content` 是**全量替换**(不是 patch),走与 `add_mindmap_seed` 一致的全套校验——上面那份字段合同一条不放松。
- **只对 `source=agent` 的图开放**。学习者自己长出来的图不许 agent 动,会打 `PERMISSION`;别人 pair 的图一律 `NOT_FOUND`。
- 写入会同时同步 `content` 与 `agent_seed_snapshot` 两列——所以学习者点 "Clear & redo" 复原时拿到的是你改后的新种子,不会诈尸出旧方言图。

## 5. 交付前自检

- [ ] 零 `source`/`target`(端点字段名只认 `from_node_id`/`to_node_id`;`label` 是合法可选字段,不用查)
- [ ] links 里没有父子关系的复印件
- [ ] 每个 branch 标题说得出主张;图与课文清单不同构
- [ ] 无连续独子链;note ≤12 字
- [ ] 坐标全部在界内;同级 y 差 ≥14;按字宽估过无重叠
- [ ] 调 MCP 工具 `verify_prep`(传这节课的 `lesson_id`),清掉它报的每一条 ❌,⚠️ 逐条过目

🖤
