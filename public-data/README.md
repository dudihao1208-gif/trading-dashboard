此目录由 GitHub Actions（`refresh_public_data` 任务）定期写入。

- `calendar.json`：本周宏观事件（Forex Factory 公开数据），供网页同源读取（该源站本身无 CORS）。
- `equities.json`：美股正股报价，用于和代币化美股（xStocks）对比（Yahoo Finance 无 CORS）。

不要把密钥放进这些文件。首次工作流运行前，网页会显示“等待刷新”。
