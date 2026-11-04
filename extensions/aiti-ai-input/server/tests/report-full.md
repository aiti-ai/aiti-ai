# ASR 模型对比测试报告

- 时间: 2026-09-05 16:26:30
- 录音: 30 段（目录 /home/pi/.pi/web/data/aiti-ai-input/recordings）
- 热词: ['aiti', 'devtools', 'pi', '扩展', '认领', '模型', '改动', '文本']
- 模型: ['qwen3-0.6b', 'qwen3-1.7b', 'nano', 'sensevoice']

| 文件 | 时长s | qwen3-0.6b（ms/命中/复述） | qwen3-1.7b（ms/命中/复述） | nano（ms/命中/复述） | sensevoice（ms/命中/复述） |
|---|---|---|---|---|---|
| vad_20260905_155613.wav | 7.92 | 国务院发展研究中心市场经济研究所副所长，邓玉松认为。<br>19340ms ✗不中 | 国务院发展研究中心市场经济研究所副所长邓玉松认为。<br>16375ms ✗不中 | (空/失败)<br>29836ms ✗不中 | (空/失败)<br>1118ms ✗不中 |
| vad_20260905_155847.wav | 13.56 | (空/失败)<br>16ms ✗不中 | (空/失败)<br>67ms ✗不中 | (空/失败)<br>36ms ✗不中 | (空/失败)<br>839ms ✗不中 |
| vad_20260905_155902.wav | 9.21 | (空/失败)<br>8ms ✗不中 | (空/失败)<br>62ms ✗不中 | (空/失败)<br>84ms ✗不中 | (空/失败)<br>811ms ✗不中 |
| vad_20260905_155917.wav | 11.09 | (空/失败)<br>9ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>18ms ✗不中 | (空/失败)<br>814ms ✗不中 |
| vad_20260905_155928.wav | 5.63 | (空/失败)<br>8ms ✗不中 | (空/失败)<br>17ms ✗不中 | (空/失败)<br>44ms ✗不中 | (空/失败)<br>892ms ✗不中 |
| vad_20260905_155937.wav | 2.22 | (空/失败)<br>2ms ✗不中 | (空/失败)<br>1ms ✗不中 | (空/失败)<br>6ms ✗不中 | (空/失败)<br>817ms ✗不中 |
| vad_20260905_155952.wav | 1.96 | (空/失败)<br>2ms ✗不中 | (空/失败)<br>1ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>831ms ✗不中 |
| vad_20260905_160002.wav | 2.99 | (空/失败)<br>8ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>10ms ✗不中 | (空/失败)<br>816ms ✗不中 |
| vad_20260905_160505.wav | 16.64 | (空/失败)<br>21ms ✗不中 | (空/失败)<br>35ms ✗不中 | (空/失败)<br>42ms ✗不中 | (空/失败)<br>829ms ✗不中 |
| vad_20260905_160523.wav | 11.52 | (空/失败)<br>39ms ✗不中 | (空/失败)<br>38ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>803ms ✗不中 |
| vad_20260905_160532.wav | 5.97 | (空/失败)<br>8ms ✗不中 | (空/失败)<br>5ms ✗不中 | (空/失败)<br>12ms ✗不中 | (空/失败)<br>818ms ✗不中 |
| vad_20260905_160537.wav | 2.05 | (空/失败)<br>2ms ✗不中 | (空/失败)<br>1ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>813ms ✗不中 |
| vad_20260905_160542.wav | 2.47 | (空/失败)<br>2ms ✗不中 | (空/失败)<br>2ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>798ms ✗不中 |
| vad_20260905_160548.wav | 3.75 | (空/失败)<br>9ms ✗不中 | (空/失败)<br>9ms ✗不中 | (空/失败)<br>19ms ✗不中 | (空/失败)<br>807ms ✗不中 |
| vad_20260905_160607.wav | 8.62 | (空/失败)<br>12ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>23ms ✗不中 | (空/失败)<br>824ms ✗不中 |
| vad_20260905_160621.wav | 8.53 | (空/失败)<br>7ms ✗不中 | (空/失败)<br>13ms ✗不中 | (空/失败)<br>24ms ✗不中 | (空/失败)<br>823ms ✗不中 |
| vad_20260905_160712.wav | 3.07 | (空/失败)<br>43ms ✗不中 | (空/失败)<br>57ms ✗不中 | (空/失败)<br>45ms ✗不中 | (空/失败)<br>826ms ✗不中 |
| vad_20260905_160720.wav | 4.09 | (空/失败)<br>8ms ✗不中 | (空/失败)<br>33ms ✗不中 | (空/失败)<br>57ms ✗不中 | (空/失败)<br>844ms ✗不中 |
| vad_20260905_160734.wav | 0.43 | (空/失败)<br>1ms ✗不中 | (空/失败)<br>1ms ✗不中 | (空/失败)<br>1ms ✗不中 | (空/失败)<br>802ms ✗不中 |
| vad_20260905_160911.wav | 14.67 | (空/失败)<br>42ms ✗不中 | (空/失败)<br>18ms ✗不中 | (空/失败)<br>23ms ✗不中 | (空/失败)<br>827ms ✗不中 |
| vad_20260905_161238.wav | 2.64 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>10ms ✗不中 | (空/失败)<br>10ms ✗不中 | (空/失败)<br>819ms ✗不中 |
| vad_20260905_161248.wav | 3.16 | (空/失败)<br>41ms ✗不中 | (空/失败)<br>62ms ✗不中 | (空/失败)<br>46ms ✗不中 | (空/失败)<br>815ms ✗不中 |
| vad_20260905_161325.wav | 4.44 | (空/失败)<br>14ms ✗不中 | (空/失败)<br>16ms ✗不中 | (空/失败)<br>29ms ✗不中 | (空/失败)<br>810ms ✗不中 |
| vad_20260905_161334.wav | 3.58 | (空/失败)<br>7ms ✗不中 | (空/失败)<br>10ms ✗不中 | (空/失败)<br>18ms ✗不中 | (空/失败)<br>809ms ✗不中 |
| vad_20260905_161339.wav | 5.46 | (空/失败)<br>10ms ✗不中 | (空/失败)<br>9ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>805ms ✗不中 |
| vad_20260905_161344.wav | 1.71 | (空/失败)<br>2ms ✗不中 | (空/失败)<br>1ms ✗不中 | (空/失败)<br>2ms ✗不中 | (空/失败)<br>802ms ✗不中 |
| vad_20260905_161351.wav | 4.61 | (空/失败)<br>8ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>7ms ✗不中 | (空/失败)<br>827ms ✗不中 |
| vad_20260905_161359.wav | 9.73 | (空/失败)<br>37ms ✗不中 | (空/失败)<br>31ms ✗不中 | (空/失败)<br>37ms ✗不中 | (空/失败)<br>828ms ✗不中 |
| vad_20260905_161427.wav | 3.58 | (空/失败)<br>15ms ✗不中 | (空/失败)<br>36ms ✗不中 | (空/失败)<br>27ms ✗不中 | (空/失败)<br>825ms ✗不中 |
| vad_20260905_161442.wav | 5.29 | (空/失败)<br>8ms ✗不中 | (空/失败)<br>11ms ✗不中 | (空/失败)<br>13ms ✗不中 | (空/失败)<br>817ms ✗不中 |

## 错误
- nano:0: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:0: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:1: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:1: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:1: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:1: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:2: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:2: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:2: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:2: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:3: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:3: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:3: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:3: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:4: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:4: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:4: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:4: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:5: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:5: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:5: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:5: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:6: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:6: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:6: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:6: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:7: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:7: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:7: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:7: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:8: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:8: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:8: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:8: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:9: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:9: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:9: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:9: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:10: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:10: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:10: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:10: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:11: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:11: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:11: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:11: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:12: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:12: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:12: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:12: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:13: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:13: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:13: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:13: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:14: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:14: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:14: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:14: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:15: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:15: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:15: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:15: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:16: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:16: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:16: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:16: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:17: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:17: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:17: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:17: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:18: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:18: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:18: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:18: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:19: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:19: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:19: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:19: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:20: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:20: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:20: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:20: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:21: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:21: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:21: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:21: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:22: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:22: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:22: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:22: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:23: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:23: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:23: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:23: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:24: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:24: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:24: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:24: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:25: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:25: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:25: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:25: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:26: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:26: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:26: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:26: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:27: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:27: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:27: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:27: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:28: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:28: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:28: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:28: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-0.6b:29: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- qwen3-1.7b:29: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- nano:29: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la
- sensevoice:29: HIP error: unspecified launch failure
Search for `hipErrorLaunchFailure' in https://rocm.docs.amd.com/projects/HIP/en/la