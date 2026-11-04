# ASR 模型对比测试报告

- 时间: 2026-09-05 16:29:06
- 录音: 8 段（目录 /home/pi/.pi/web/data/aiti-ai-input/recordings）
- 热词: ['aiti', 'devtools', 'pi', '扩展', '认领', '模型', '改动', '文本']
- 模型: ['qwen3-1.7b']

| 文件 | 时长s | qwen3-1.7b（ms/命中/复述） |
|---|---|---|
| vad_20260905_155613.wav | 7.92 | 国务院发展研究中心市场经济研究所副所长邓玉松认为。<br>21802ms ✗不中 |
| vad_20260905_155847.wav | 13.56 | 我们现在来说说我们这边专业术语：Aitai Devtoo…<br>3304ms ✓devtools |
| vad_20260905_155902.wav | 9.21 | 我再说一遍，我们有 aiti folder file p…<br>14485ms ✓aiti/devtools |
| vad_20260905_155917.wav | 11.09 | 我们现在有大量的专业术语，包括 aiti、ai inpu…<br>17102ms ✓aiti |
| vad_20260905_155928.wav | 5.63 | Processor AIT is else it's a…<br>8908ms ✗不中 |
| vad_20260905_155937.wav | 2.22 | Hi, DevTools.<br>4790ms ✓devtools |
| vad_20260905_155952.wav | 1.96 | 我用了几段。<br>3618ms ✗不中 |
| vad_20260905_160002.wav | 2.99 | 还是大量直接出去审核。<br>1074ms ✗不中 |
