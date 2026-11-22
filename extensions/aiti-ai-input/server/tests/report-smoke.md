# ASR 模型对比测试报告

- 时间: 2026-09-05 16:24:42
- 录音: 2 段（目录 /home/pi/.pi/web/data/aiti-ai-input/recordings）
- 热词: ['aiti', 'devtools', 'pi', '扩展', '认领', '模型', '改动', '文本']
- 模型: ['qwen3-0.6b', 'nano', 'sensevoice']

| 文件 | 时长s | qwen3-0.6b（ms/命中/复述） | nano（ms/命中/复述） | sensevoice（ms/命中/复述） |
|---|---|---|---|---|
| vad_20260905_155613.wav | 7.92 | 国务院发展研究中心市场经济研究所副所长，邓玉松认为。<br>19728ms ✗不中 | 国务院发展研究中心市场经济研究所副所长邓郁松认为<br>26735ms ✗不中 | 国务院发展研究中心市场经济研究所副所长邓玉松认为<br>2415ms ✗不中 |
| vad_20260905_155847.wav | 13.56 | 我们现在来说说我们这边的专业术语：AIT、DevTool…<br>19193ms ✓devtools/认领 | 我们现在来说说我们这边专业术语，PI DEVTOOLS …<br>2387ms ✓devtools/pi | for external high double i t…<br>382ms ✗不中 |
