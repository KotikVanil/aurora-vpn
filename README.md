# Aurora VPN

Красивый VPN-клиент для Windows в духе Happ / Incy: вставляешь ключ или ссылку подписки — и подключаешься.
Внутри ядра [sing-box](https://github.com/SagerNet/sing-box) и [Xray](https://github.com/XTLS/Xray-core),
интерфейс на Tauri 2 с живым WebGL-«сиянием».

**[Скачать последнюю версию](https://github.com/KotikVanil/aurora-vpn/releases/latest)**:
`Aurora-VPN-x.y.z-setup.exe` для Windows, `Aurora-VPN-x.y.z.apk` для Android (arm64, Android 8+).
Дальше приложение обновляется само (Настройки → Обновления).

### Android

Тот же интерфейс и та же логика ключей/подписок, что на ПК. Весь трафик телефона идёт через VPN
(VpnService → Xray TUN → sing-box), выбранные приложения можно пустить мимо VPN (банки, Госуслуги).
Есть плитка в шторке быстрых настроек, уведомление с кнопкой «Отключить» и поддержка
системного «Постоянного VPN».

## Возможности

- **Ключи:** VLESS (Reality, Vision, TCP / WS / gRPC / HTTPUpgrade / XHTTP), VMess, Trojan, Shadowsocks (в т.ч. 2022),
  Hysteria2 (obfs, port hopping), Hysteria v1, TUIC, AnyTLS, WireGuard, SOCKS5.
- **Подписки** в любом популярном формате: base64-список, JSON Happ/Xray, JSON sing-box, Clash/Mihomo YAML.
  Показывает трафик, срок, описание серверов и разделы провайдера («── ⚡ БЫСТРЫЕ ──»), как в Happ.
- **Совместимость с панелями** (Remnawave, Marzban и др.): передаёт ID устройства (HWID), как Happ и Incy,
  перебирает форматы, распознаёт заглушки «приложение не поддерживается».
- **Режимы:** системный прокси (без прав администратора) или TUN (весь трафик ПК, включая игры).
- **Маршруты:** «умный» режим (российские сайты и IP напрямую), блокировка рекламы, свои списки доменов,
  приложения мимо VPN (split tunnel по .exe), фрагментация TLS против DPI.
- **Тест задержки** через ядро, как в Happ: работает и для UDP-протоколов. Кнопка «Лучший сервер».
- Живой график скорости, внешний IP и страна, QR-код ключа для телефона, трей, автозапуск,
  автопереподключение, обновление подписок по расписанию, 4 темы сияния.
- Горячие клавиши: `Пробел` — подключить/отключить, `Ctrl+V` — добавить ключ из буфера, `Ctrl+1…5` — вкладки.

## Сборка из исходников

Нужны Node.js 20+, Rust (MSVC) и Python 3.

```
npm install
python tools/fetch_cores.py      # скачивает sing-box, Xray и гео-базы в src-tauri/bin
npm run tauri build              # установщик: src-tauri/target/release/bundle/nsis/
```

Android (нужны Android SDK 36 и JDK 17+):

```
python tools/fetch_android.py    # libv2ray.aar (Xray с TUN) и sing-box под arm64
npm run build:android-web        # интерфейс в android/app/src/main/assets/web
cd android && gradlew assembleRelease
```

Для подписи релиза нужен `android/keystore.properties` со своим ключом (в git не хранится).

Проверки без подключения к VPN:

```
node tools/test_configs.mjs              # все протоколы и форматы -> sing-box check / xray -test
node tools/test_android_configs.mjs      # конфиги Android-цепочки (Xray TUN -> sing-box)
node tools/test_sub.mjs <ссылка>         # разбор реальной подписки (ключи не печатаются)
```

Релиз (для автообновления): поднять версию в `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` и запустить `python tools/release.py "что нового"`.

## Устройство

- `src/core/links.js` — разбор ключей и подписок (чистые функции, тестируются в Node).
- `src/core/config.js` — генерация конфигов sing-box и Xray (Xray только для XHTTP / mKCP / VLESS-encryption,
  поверх него sing-box даёт прокси/TUN, DNS, маршруты и статистику).
- `src/main.js` — интерфейс, `src/aurora.js` — WebGL-фон, `src/sound.js` — синтезированные звуки.
- `src-tauri/src/lib.rs` — процессы ядер (Windows Job Object), системный прокси, трей, пинги,
  загрузка подписок, тест задержки, обновления.

Данные приложения: `%APPDATA%\com.aurora.vpnclient`.

## Лицензии ядер

sing-box распространяется под GPL-3.0, Xray-core — под MPL-2.0. Установщик содержит их официальные
сборки без изменений; исходники — по ссылкам выше.
