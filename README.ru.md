<p align="center">
  <img src="public/wireguard.svg" width="72" height="77" alt="Логотип WireGuard Desktop">
</p>

<h1 align="center">WireGuard Desktop</h1>

<p align="center">
  Удобный клиент WireGuard для macOS и Windows.<br>
  Несколько туннелей, выборочная маршрутизация, живой график трафика — без облачного аккаунта.
</p>

<p align="center">
  <a href="README.md">English</a>　·　<strong>Русский</strong>
</p>

<p align="center">
  <a href="https://github.com/Salvehn/wireguard-ui/releases/latest/download/WireGuard-Desktop-arm64.dmg"><strong>macOS</strong></a>
 　·　
  <a href="https://github.com/Salvehn/wireguard-ui/releases/latest/download/WireGuard-Desktop-x64-Setup.exe"><strong>Windows</strong></a>
 　·　
  <a href="https://github.com/Salvehn/wireguard-ui/releases/latest"><strong>История версий</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Salvehn/wireguard-ui?display_name=tag&sort=semver&style=flat-square&color=58a6ff" alt="Последний релиз">
  <img src="https://img.shields.io/github/actions/workflow/status/Salvehn/wireguard-ui/desktop-release.yml?branch=main&style=flat-square&label=build" alt="Статус сборки">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-24292f?style=flat-square&logo=apple&logoColor=white" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?style=flat-square&logo=windows11&logoColor=white" alt="Windows x64">
</p>

![WireGuard Desktop с вымышленными демонстрационными соединениями](docs/images/desktop-macos-window.png)

<p align="center"><sub>Все профили и данные трафика вымышлены. На скриншоте нет реальных подключений или приватных ключей.</sub></p>

## Возможности

- **Независимые туннели.** Импортируйте профили `.conf` и подключайте несколько VPN одновременно.
- **Smart tunneling.** Направляйте через каждый профиль выбранные адреса, домены, поддомены или приложения.
- **Живой статус.** Следите за скоростью, счётчиками трафика, handshake и последними событиями.
- **Управление с рабочего стола.** Используйте основное окно, строку меню macOS или системный трей Windows.
- **Локальное хранение.** Конфигурации и приватные ключи остаются на компьютере.
- **Безопасные обновления.** Устанавливайте криптографически проверенные обновления прямо из приложения.
- **Удобный интерфейс.** Русский и английский языки, светлая, тёмная и системная темы.

## Smart tunneling

Откройте **Smart tunneling** у отключённого профиля и выберите, какой трафик направлять через это соединение. Правила сохраняются в профиле и только сужают его исходные `AllowedIPs`.

| Режим                       | Трафик через соединение                                       |
| --------------------------- | ------------------------------------------------------------- |
| Маршруты конфигурации       | Маршруты импортированного `.conf`                             |
| Только адреса из списка     | Выбранные домены, IP-адреса и сети CIDR                       |
| Кроме адресов из списка     | Исходные маршруты за исключением выбранных адресов            |
| Только выбранные приложения | Процессы внутри выбранных `.app` в macOS или `.exe` в Windows |
| Кроме выбранных приложений  | Все остальные процессы                                        |

<details>
<summary><strong>Домены, маски и DNS</strong></summary>

- `example.com` обозначает сам домен. `*.example.com` охватывает поддомены любого уровня, но не сам домен. Добавьте обе записи, чтобы охватить домен целиком.
- Маски получают IPv4- и IPv6-адреса из системных DNS-запросов до отключения профиля. Сайты с общим IP следуют одному правилу, а приложения с собственным DNS-over-HTTPS могут его обойти.
- В режиме **«Маршруты конфигурации»** DNS профиля временно становится системным. Выборочные режимы сохраняют текущий системный DNS.
- Для масок используются `/etc/resolver` в macOS и правила NRPT в Windows. Изменения журналируются и удаляются при отключении или восстановлении.

</details>

<details>
<summary><strong>Приложения и несколько VPN</strong></summary>

- Правила адресов и приложений — альтернативные режимы одного профиля. Разные профили могут одновременно работать в разных режимах.
- Конкретные рабочие подсети сохраняют приоритет. При совпадении правил приложений используется последнее подключённое соединение.
- Исключённый или невыбранный трафик может идти через другой активный VPN. Отключение одного профиля не затрагивает остальные.
- После подключения перезапустите выбранные приложения. Общие системные службы могут не определяться как часть приложения, а статистика peers WireGuard в этом режиме недоступна.

</details>

> [!NOTE]
> Маршрутизация по маскам и приложениям пока экспериментальная. Изменение активных правил приложений может ненадолго прервать их трафик.

## Установка

| Платформа | Поддерживаемая система | Скачать                                                                                                        |
| --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| macOS     | Apple Silicon          | [DMG](https://github.com/Salvehn/wireguard-ui/releases/latest/download/WireGuard-Desktop-arm64.dmg)            |
| Windows   | x64                    | [Установщик](https://github.com/Salvehn/wireguard-ui/releases/latest/download/WireGuard-Desktop-x64-Setup.exe) |

После установки импортируйте обычный файл WireGuard `.conf`. Для установки или обновления системного помощника потребуется разрешение администратора. Windows-сборка автономна: проверенный WireGuard runtime входит в состав WireGuard Desktop, отдельный клиент устанавливать не нужно.

## Разработка

Понадобятся Node.js 24 и npm.

```sh
npm ci
npm run dev
```

Проверки, которые выполняются для `main`:

```sh
npm test
npm run test:release
npm run build
```

Границы процессов и привилегий описаны в [ARCHITECTURE.md](ARCHITECTURE.md). Инструкция по сборке и публикации релизов находится в [docs/releases.md](docs/releases.md).
