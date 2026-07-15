# koishi-plugin-x-watcher

[![npm](https://img.shields.io/npm/v/koishi-plugin-x-watcher?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-x-watcher)

订阅指定 Twitter/X 用户的 推文

### 如何获取 apiKey

1. 从 Chrome 应用商店安装 [X Auth Helper extension](https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp) 扩展程序，并允许其在无痕模式下运行。
2. 切换至无痕模式后登录 Twitter/X 账号。
3. 成功登录后，在仍处于 Twitter/X 页面的状态下，点击浏览器扩展图标打开扩展弹窗。
4. 点击 \`Get Key\` 按钮, 扩展将生成 \`API_KEY\` 并显示在文本区域中。
5. 通过点击 \`API_KEY\` 按钮或手动从文本区域复制 \`API_KEY\` 。
6. 此时可以关闭浏览器，但不要主动退出登录。请注意，由于处于无痕模式，您并未执行“退出登录”操作，因此虽然浏览器会话会被清除，但 \`API_KEY\` 仍然保持有效。
7. 保存 \`API_KEY\` 以供使用。

### 如何使用

#### 基本命令

插件提供以下命令来管理 Twitter/X 推文订阅：

**订阅推文**

```
watch -m <twitter_username> [regexp]
```

- `-m`：可选参数，表示订阅推文的媒体内容(目前仅支持图片，暂不支持视频，只兼容支持图文混排的平台)
- `twitter_username`: 推特用户名（@后面的部分，不包含@符号）
- `regexp`: 可选的正则表达式，用于过滤推文内容

**取消订阅**

```
unwatch <twitter_username>
```

**查看订阅列表**

```
xlist
```

#### 使用示例

1. **订阅用户的所有推文**：

   ```
   watch elonmusk
   ```

2. **订阅包含特定关键词的推文**：

   ```
   watch elonmusk Tesla
   ```

3. **使用正则表达式匹配多个关键词**：

   ```
   watch elonmusk Tesla|SpaceX|Neuralink
   ```

4. **订阅用户的所有推文并在推送中包含图片**：

   ```
   watch -m elonmusk
   ```

5. **取消订阅**：

   ```
   unwatch elonmusk
   ```

6. **查看当前频道的订阅列表**：
   ```
   xlist
   ```

#### 正则表达式过滤

插件支持使用正则表达式过滤推文内容，只推送匹配条件的推文：

- **匹配包含链接的推文**：`https?://.*`
- **匹配包含特定标签的推文**：`#Mars|#Moon`
- **匹配特定格式内容**：`^\d+.*`（以数字开头的推文）
- **插件支持的常用正则语法**：
  - `|` - 或操作符
  - `.*` - 匹配任意字符
  - `\d+` - 匹配数字
  - `^` - 行开始
  - `$` - 行结束
  - `[]` - 字符集合
  - `()` - 分组

#### 注意事项

- 订阅是基于频道（或私聊）的，在哪个频道使用 `watch` 命令，推文更新就会发送到该频道（或私聊）
- 插件会定期检查推文更新，检查间隔可在配置中设置
- 正则表达式匹配不区分大小写
- 重新订阅同一用户会更新过滤条件
- API_KEY 需要保持有效，如果失效需要重新获取并更新配置
- 如果您拥有科学上网环境，但在使用 watch 命令时总是“获取推特用户名失败”，这大概率是 nodejs 版本过低，请使用 nodejs21 及以上版本
