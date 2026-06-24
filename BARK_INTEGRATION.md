# Bark 推送通知集成说明

## 功能概述

已为 Ark API 股票监控脚本添加 **Bark iOS 推送**功能,在价格突破时实时推送通知到 iPhone。

## 实现内容

### 1. 配置项 (Storage)
- `notificationSettings.enableBark` - 开关
- `notificationSettings.barkUrl` - Bark 推送地址

### 2. 推送方法 (sendBark)
- 触发时机:价格突破上限或下限
- 推送格式:
  ```
  标题: 🔔 价格突破提醒
  内容: 
    N个模型触发通知
    
    1. 模型名
       价格: XX.XX | 突破上限/下限: YY.YY
    
    时间: YYYY-MM-DD HH:mm:ss
  ```
- 推送参数:
  - `group=股市监控` - 分组显示
  - `sound=alarm` - 使用警报铃声
  - `level=timeSensitive` - 时效性通知(专注模式下也显示)

### 3. 设置面板 UI
在"通知设置"标签页添加:
- ✅ 开关:"开启 Bark 提醒"
- 📝 输入框:"Bark URL"(折叠显示,开关打开后展开)
- 💡 提示:"从 Bark App 复制完整推送地址"

## 使用方法

### 第一步:获取 Bark URL

1. **App Store 下载 Bark**
2. 打开 Bark App,复制推送地址
   - 格式:`https://api.day.app/YOUR_KEY`
   - 或自建服务端:`https://your-bark-server.com/YOUR_KEY`

### 第二步:配置脚本

1. 打开监控脚本的**设置面板**
2. 切换到"通知设置"标签页
3. 勾选"开启 Bark 提醒"
4. 在展开的输入框粘贴 Bark URL
5. (可选)点击"测试通知"验证推送

### 第三步:设置价格提醒

1. 在"通知设置"下方选择要监控的模型
2. 设置"向上突破"或"向下突破"价格
3. 点击"添加"

完成!当价格突破设定阈值时,会自动推送到 iPhone。

## 推送效果

### 通知特性
- ✅ **时效性通知** - 专注模式下也会显示
- 🔔 **警报铃声** - 重复播放提醒
- 📱 **分组管理** - 归类到"股市监控"组
- 📊 **批量显示** - 多个模型同时突破时合并一条通知

### 通知示例
```
🔔 价格突破提醒
3个模型触发通知

1. claude-3.5-sonnet
   价格: 105.50 | 突破上限: 100

2. gpt-4-turbo
   价格: 89.00 | 突破下限: 90

3. gemini-pro
   价格: 122.30 | 突破上限: 120

时间: 2026-06-24 15:30:45
```

## 与其他通知方式的关系

脚本现在支持 **4 种通知方式**,可任意组合:
1. ✅ **浏览器弹窗** - `enablePopup`
2. 🔔 **浏览器声音** - `enableSound`
3. 📱 **Telegram** - `enableTelegram`
4. 🍎 **Bark (新增)** - `enableBark`

触发逻辑:价格突破时,所有已启用的方式**同时发送**。

## 技术细节

### API 调用方式
使用 **GET 请求** + URL 编码:
```javascript
const url = `${barkUrl}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=股市监控&sound=alarm&level=timeSensitive`;
```

### 返回格式
```json
{
  "code": 200,
  "message": "success",
  "timestamp": 1234567890
}
```

### 错误处理
- URL 未配置:控制台警告,跳过推送
- 请求失败:控制台输出错误信息
- 解析失败:捕获异常,避免脚本中断

## 文件修改清单

修改文件:`ark-api-stock-monitor.user.js`

1. **配置结构** (行 46-54, 92-102)
   - 添加 `enableBark`、`barkUrl` 字段

2. **推送方法** (行 975-1021)
   - 新增 `sendBark()` 方法

3. **批量发送** (行 1023-1030)
   - `sendBatch()` 调用 `sendBark()`

4. **测试方法** (行 1032-1045)
   - `sendTest()` 计数 Bark

5. **UI 结构** (行 3841-3858)
   - 添加 Bark 开关和配置输入框

6. **DOM 获取** (行 3951-3959)
   - 添加 `notifBarkToggle`、`barkConfig`、`barkUrlInput`

7. **初始化** (行 3984-3987)
   - 设置 Bark 开关和 URL 初始值

8. **事件监听** (行 4020-4032)
   - Bark 开关切换和 URL 输入事件

## 测试建议

1. **配置测试**
   - 输入正确 URL → 开关打开后配置区应展开
   - 输入错误 URL → 点击测试按钮应有错误提示

2. **推送测试**
   - 点击"测试通知" → iPhone 收到测试推送
   - 设置价格提醒 → 手动修改价格数据触发

3. **兼容性测试**
   - 与 Telegram 同时开启 → 两边都收到
   - 关闭 Bark → 不影响其他通知方式

## 常见问题

**Q: 没收到推送?**
A: 检查:
1. Bark URL 是否正确(从 App 复制,不要手打)
2. 开关是否打开
3. 手机是否联网
4. 控制台是否有错误信息

**Q: 推送延迟?**
A: Bark 基于苹果 APNs,通常秒级送达。如果延迟:
1. 检查网络环境
2. 尝试"测试通知"看是否一直慢
3. 考虑自建 Bark 服务端(更稳定)

**Q: 推送太频繁?**
A: 调整价格提醒阈值,避免设置在频繁波动区间。

**Q: 能否自定义推送内容?**
A: 目前格式固定。如需自定义,修改 `sendBark()` 方法的 `title` 和 `body` 变量。

## 版本信息

- 集成版本: v1.0
- 集成日期: 2026-06-24
- Bark API 版本: v2
- 兼容性: Tampermonkey 4.0+

## 相关链接

- [Bark GitHub](https://github.com/Finb/Bark)
- [Bark 官方文档](https://bark.day.app)
- [Ark 监控脚本仓库](https://github.com/ZiugatWong/ark-api-model-stock-market-monitor)
