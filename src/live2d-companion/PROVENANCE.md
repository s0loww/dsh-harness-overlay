# Происхождение файлов поставки DSH 1С

| Файлы | Источник |
| --- | --- |
| `assets/model/Hiyori/hiyori_pro_t11.model3.json`, `.moc3`, `.physics3.json`, `.pose3.json`, `.cdi3.json`, `hiyori_pro_t11.2048/texture_00.png`, `texture_01.png`, `motion/hiyori_m01…m10.motion3.json`, `ReadMe.txt` | Официальный образец Live2D Inc. «Hiyori Momose» PRO (`hiyori_pro/runtime/**` и `hiyori_pro/ReadMe.txt`) из архива `https://cubism.live2d.com/sample-data/bin/hiyori/hiyori_en.zip` (46 195 926 байт, SHA-256 `1e4254d561f2a151562aa67036d78e17e4ffee08869b8ce10ab6052a05e2b3a4`), загружен 03.11.2026 со страницы <https://www.live2d.com/en/learn/sample/momose-hiyori/>. Файлы скопированы без изменений. |
| `assets/model/Miara/miara_pro_t03.model3.json`, `.moc3`, `.physics3.json`, `.cdi3.json`, `miara_pro_t03.4096/texture_00.png`, `motion/Scene1…Scene3.motion3.json`, `ReadMe.txt` | Официальный образец Live2D Inc. «Miara» PRO (`runtime/**` и `ReadMe.txt`) из архива `https://cubism.live2d.com/sample-data/bin/miara/miara_en.zip` (40 241 602 байт, SHA-256 `021f44d062d7cc1cbe6ac13e25ef7e1b981db187b8b5c4af521f2cba3613d9a4`), загружен 03.11.2026 со страницы <https://www.live2d.com/en/learn/sample/miara/>. Файлы скопированы без изменений; `cmo3` и `can3` не копировались. |
| `assets/model/Miara/manifest.json` | Создан для плагина по `miara_pro_t03.model3.json` и метаданным движений: длительности, параметры, подписи, `stateMotions`. |
| `assets/model/Hiyori/manifest.json` | Создан для плагина по `hiyori_pro_t11.model3.json` и метаданным движений: длительности, параметры, подписи, `stateMotions`. |
| Модель Nicole | Удалена 03.11.2026: фанатская модель без подтверждённого автора и лицензии. |
| Модель Whale (`c_0120`) | В поставку не входит; раздел ниже описывает только upstream. |

Условия образца: Free Material License Agreement Live2D (v1.6) и Terms of Use for Live2D Cubism
Sample Data. Уведомление об авторских правах приведено в `NOTICE.md`.

---

# 素材来源与许可范围（PROVENANCE）

本仓库的**代码**按 MIT 许可（见 [`LICENSE`](LICENSE)），**作者：Andersen216**（<https://github.com/Andersen216>）。
`assets/model/`、`assets/vendor/` 与 `assets/pet.js` 里内嵌的美术/运行时素材
**不在 MIT 覆盖范围内**，按下表各自说明。

> **一句话**：代码随便用（MIT）；**模型素材非商业**（CC BY-NC-SA 4.0），
> 署名要写全三位：上善无形 / ZipZipPipe / 氵六青。完整署名与致谢见
> [`AUTHORS.md`](AUTHORS.md)。

## 一、许可范围

| 范围 | 许可 |
|---|---|
| `lib/`、`tools/`、`cordis.patch.yml`、`package.json`、文档 | **MIT**（Copyright © 2026 **Andersen216**） |
| `assets/model/**`（moc3 / 贴图 / 表情 / 动作 / 物理 / cdi3） | **不适用 MIT**，**非商业**。CC BY-NC-SA 4.0（署名：上善无形 / ZipZipPipe / 氵六青）。由模型作者无偿分享，按其使用须知原样随本项目使用与分发 |
| `assets/vendor/live2dcubismcore.min.js` | **不适用 MIT**。Live2D Inc. 版权所有，按 Live2D Cubism SDK 的许可条款（Redistributable Code）使用 |
| `assets/vendor/pixi.min.js` | **MIT**（PIXI.js v6.5.10） |
| `assets/vendor/cubism4.min.js` | **MIT**（pixi-live2d-display v0.4.0） |

## 一点五、角色形象的三重版权链（必须都署名）

| 版权所有人 | 贡献 | 主页 |
| --- | --- | --- |
| **上善无形**（上善） | 鲸鱼娘角色形象原作，原创 OC「溟月」 | <https://space.bilibili.com/4456176> |
| **ZipZipPipe** | 加入 DeepSeek 元素的「女仆鲸鱼娘」二次设计 | <https://space.bilibili.com/4168597> |
| **氵六青** | 本仓库所用 Live2D 模型（绑定、动作、表情） | <https://space.bilibili.com/11272072> |

形象链：上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘 → 氵六青 Live2D 化。

**非商业**：本项目完全免费，不收费、不带货、不接广告变现、不卖周边、
不作为付费产品或服务的卖点。改编/再分发美术素材请按
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh)
（署名 — 非商业性使用 — 相同方式共享）执行，并说明修改内容。

## 二、逐项来源

| 文件 | 来源 / 说明 |
|---|---|
| `assets/model/c_0120.moc3`、`c_0120.2048/texture_*.png`、`c_0120.physics3.json`、`c_0120.cdi3.json`、`motions/*.motion3.json`、`expressions/*.exp3.json` | 来自工作区 `DS鲸鱼娘/DS鼠控版.zip`（VTube Studio 模型包，原作者 B 站 **@氵六青**，UID 11272072） |
| `assets/model/c_0120.model3.json`、`assets/model/manifest.json` | **本项目生成**（`tools/build-model.mjs`）。原包没有 `model3.json`（VTube Studio 直接按文件名加载动作），这里把 8 个动作注册成标准 motion group，并抽出一份表情参数清单 |
| `assets/vendor/live2dcubismcore.min.js` | 取自 Live2D 官方 CDN `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` |
| `assets/vendor/pixi.min.js` | npm `pixi.js@6.5.10` 的 `dist/browser/pixi.min.js` |
| `assets/vendor/cubism4.min.js` | npm `pixi-live2d-display@0.4.0` 的 `dist/cubism4.min.js` |

## 三、模型作者的使用须知（原文照录）

工作区 `DS鲸鱼娘/使用须知.txt`：

```
商用直播√
自印物料√

禁止任何形式的盗用以及出售，此模型为无偿分享

模型制作：B站@氵六青（11272072）
使用问题和定制桌宠请加QQ交流群：645169617
```

也就是说：**允许**商用直播、自印物料、以及像本项目这样的自定义桌宠改造；
**禁止**盗用与出售。本项目按此范围使用，不额外授予任何权利。

补充：氵六青同意转载/开源该模型，但**这不解除角色形象本身的许可条件**——
形象由 上善无形 与 ZipZipPipe 以 CC BY-NC-SA 4.0 发布，所以
**非商业（NC）与相同方式共享（SA）依然有效**。因此本插件整体按
「代码 MIT + 素材 CC BY-NC-SA 4.0、非商业」发布。

## 四、权利主张 / Takedown

如果你认为本项目中有素材侵犯了你的权利，请开一条 issue 说明**文件名**与**依据**，
核实后会立即替换或移除，不附加其它条件。
