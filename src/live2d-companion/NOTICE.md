# NOTICE — лицензии и уведомления / License layering & attribution

`LICENSE` (MIT) покрывает только код плагина. Модель персонажа и runtime Live2D
распространяются на собственных условиях.

`LICENSE` (MIT) covers the plugin code only. The character model and the Live2D runtime
ship under their own terms.

---

## 1. Код / Code

- **Область / Scope**: `lib/`, `cordis.patch.yml`, `assets/pet.js`
- **Лицензия / License**: MIT, Copyright © 2026 Andersen216 (upstream), см. [`LICENSE`](LICENSE).
  Адаптация для DSH 1С распространяется на тех же условиях.

## 2. Модели персонажей / Character models

- **Область / Scope**: `assets/model/Miara/**` — `*.moc3`, текстура, `*.motion3.json`, physics, cdi,
  `model3.json`, `ReadMe.txt`. `manifest.json` — служебный файл плагина.
- **Правообладатель / Copyright**: Live2D Inc. Miara — оригинальный персонаж Live2D Inc.;
  иллюстрация: Sasamotoroko; моделирование: Live2D.
- **Область / Scope**: `assets/model/Hiyori/**` — `*.moc3`, текстуры, `*.motion3.json`, physics, pose,
  cdi, `model3.json`, `ReadMe.txt`. `manifest.json` — служебный файл плагина.
- **Правообладатель / Copyright**: Live2D Inc. Hiyori Momose — оригинальный персонаж Live2D Inc.;
  иллюстрация: Kani Biimu; моделирование: Live2D.
- **Условия / Terms**: [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
  (v1.6, 2025-02-03) и [Terms of Use for Live2D Cubism Sample Data](https://www.live2d.com/en/learn/sample/model-terms/).
  Коммерческое использование разрешено General User и Small-Scale Enterprise (годовая выручка менее
  10 млн иен). Дизайн персонажей менять нельзя; распространять образцы отдельно от продукта нельзя.
- **Обязательное уведомление / Required notice**:

  > This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

- Исходные уведомления Live2D сохранены без изменений в `assets/model/Miara/ReadMe.txt` и `assets/model/Hiyori/ReadMe.txt`.

## 3. Сторонний runtime / Third-party runtime

| Компонент / Component | Лицензия / License | Правообладатель / Copyright |
| --- | --- | --- |
| Live2D Cubism Core (`assets/vendor/live2dcubismcore.min.js`) | Live2D Proprietary Software License (Redistributable Code) | Live2D Inc. |
| PIXI.js 6.5.10 (`assets/vendor/pixi.min.js`) | MIT | PIXI.js contributors |
| pixi-live2d-display 0.4.0 (`assets/vendor/cubism4.min.js`) | MIT | pixi-live2d-display contributors |

## 4. Графика upstream / Upstream artwork

Модель «鲸鱼娘» из upstream (CC BY-NC-SA 4.0; 上善无形 / ZipZipPipe / 氵六青) и модель Nicole
в эту поставку не входят. Сведения об авторах upstream сохранены в [`AUTHORS.md`](AUTHORS.md)
и [`PROVENANCE.md`](PROVENANCE.md).

The upstream Whale Girl artwork (CC BY-NC-SA 4.0) and the Nicole model are not shipped.
