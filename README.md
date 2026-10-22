# 抖音小店经营诊断工具包 · 开源通用版

一个**纯 Node、零依赖**的命令行工具：把你在抖店后台 / 电商罗盘 / 巨量千川导出的 Excel 或 CSV，
跑成一份**带数据证据的经营诊断报告**（HTML + JSON + Markdown 摘要），覆盖规模、转化、商品卡入池、
千川 ROI、体验分、履约、达人等维度，并按 P0/P1/P2 给出「数据证据 → 量化影响 → 根因链 → 可照做动作」。

> ⚠️ 本仓库是**通用开源工具包**，**不含任何特定店铺的数据、名称或导出样本**。你需用自己店铺的导出文件运行。

## 为什么做这个
抖音小店运营有大量的「平台专有口径」坑：体验分是百分制流量闸门、保本 ROI = 1/毛利率、商品卡看入池率不看上架数、
素材是投放第一变量…… 这些规则散在经验里。本工具把规则固化成引擎与阈值表，让诊断可复现、可审计、不脑补。

## 快速开始

```bash
# 1) 照 data/export_checklist.md 从抖店后台导出数据，放到一个目录（如 ./我的导出）
# 2) 用你自己的参数跑（毛利率/扣点/退款率/签收率等，见 kb/calibration.md）
node scripts/diag.mjs \
  --in ./我的导出 \
  --store "你的店铺名" \
  --assumptions-json '{"gross_margin":0.3,"platform_rate":0.05,"refund_rate_assumed":0.08,"sign_rate":0.95}' \
  --out-html out/诊断报告.html --out-json out/diag.json --out-md out/摘要.md
```

- 不带 `--in` 会直接报错（仓库**不附带示例数据**，请用你自己的导出文件）。
- 不传 `--assumptions-json` 时用内置 `DEFAULT_ASSUMPTIONS`，报告会标注「未校准」，涉及钱的结论仅作方向参考。

## 报告结构（十段）
数据整理 → 口径与数据质量声明 → 问题诊断(P0/P1/P2) → 解决方案汇总 → 落地工作表 →
商品四象限 → 渠道与结构 → 八维评分卡 → 数据缺口清单 → 关键结论与动作顺序。

## 目录
```
douyin-ops-codex-public/
├── CODEX.md              # OpenAI Codex 项目指令（领域规则，供 Codex 读取）
├── README.md
├── scripts/
│   ├── diag.mjs        # 诊断引擎 CLI（入口）
│   └── lib/           # 解析 / 分析 / 报告 引擎
├── kb/
│   ├── metrics.json    # 指标口径与阈值（引擎运行时读取）
│   └── calibration.md  # 21 个可校准参数及取数方法
└── data/
    ├── files.json      # 导出列名字典
    └── export_checklist.md  # 数据导出清单（照单导出）
```

## 在 OpenAI Codex 中使用
本仓库根目录的 `CODEX.md` 会被 Codex 自动读取。把仓库打开为 Codex 的工作目录即可，例如：
```bash
codex   # 在仓库根目录启动，自然语言下达任务：
        # "用 ./我的导出 跑诊断，把 P0/P1 按动作顺序排成落地表"
```

## License
MIT —— 见 `LICENSE`。
