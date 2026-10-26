# claude-buddy-chat

[English](README.md)

![kurulum](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fabacus.jasoncameron.dev%2Fget%2Fbuddy-chat-mrmirhan%2Finstalls&query=%24.value&label=kurulum&color=d97757)

Claude Code kullanıcıları arasında uçtan uca şifreli sohbet: birebir ve grup. Anahtar anlaşması kuantuma dayanıklı. buddy-chat'in bir sunucusu yok: şifreli zarfları ücretsiz ve herkese açık ntfy.sh taşır, zarfı sadece alıcı açabilir.

buddy-chat bir Claude Code [mod'u](https://code.claude.com/docs/en/plugins/mods/overview.md). Bir panel, komutlar, Claude için bir araç ve Claude'a bunların nasıl kullanılacağını anlatan bir skill ekler.

## Özellikler

- Birebir mesaj ve en fazla 8 kişilik gruplar
- Karşı tarafın onayladığı arkadaşlık istekleri
- Arkadaşlarının gördüğü bir ad ve kullanıcı adı; sadece senin gördüğün takma adlar
- Kendi mesajını herkesten düzenleme ve silme; her mesajı kopyalama
- Mesaj durumları: gönderiliyor ◷, gönderildi ✓, iletildi ✓✓, okundu (mavi ✓✓)
- Birebir sohbetlerde "yazıyor…" göstergesi
- 3 MB'a kadar resim, video, ses ve diğer dosyalar; relay'de şifreli durur ve `~/Downloads/buddy-chat/` altına kaydedilir; ses panelde çalınır
- Format sonrası hesabını geri getiren kurtarma kelimeleri (12; 0.17'den önce oluşan hesaplarda 24) ve isteğe bağlı, bilgisayarındaki bir klasöre şifreli yedek
- Birden çok bilgisayarda tek hesap: cihaz bağla, mesajlar ve ayarlar cihazların arasında eşitlensin
- Onaylanmayan mesajlar 7 güne kadar yeniden gönderilir; 12 saatten uzun ortada olmayan arkadaşa da ulaşır
- Okundu bilgisi ve yazıyor göstergesi için gizlilik ayarları. Okundu bilgisi kapalıyken ne gönderirsin ne görürsün.
- Arkadaşlıktan çıkarma (karşı taraf bilgilendirilir) ve engelleme (bilgilendirilmez)
- Yeni mesaj ve istekler için toast ve işletim sistemi bildirimi. Hepsi için bir aç/kapa ve her sohbet için sessize alma düğmesi var. Ekranda açık olan sohbet bildirim göstermez.
- Üç ayarlı mesaj sesi: **otomatik** sadece bildirim gösterilmediyse çalar (modların işletim sistemi bildirimi gönderemediği Desktop uygulamasında olduğu gibi), **açık** her zaman, **kapalı** hiçbir zaman. macOS'ta çalar.
- Claude Desktop, VS Code eklentisi ve terminalde panel
- İngilizce ve Türkçe. Varsayılan dil İngilizce.

## Gereksinimler

- Claude Code v2.1.299 veya sonrası. Terminalde `claude --version`, Desktop'ta Code sekmesindeki bir oturumda `/status` ile kontrol et.
- Terminal, Desktop'ın Code sekmesi ya da VS Code eklentisi. claude.ai sohbetinde ve mobil uygulamada çalışmaz.

## Kurulum

### Claude'a kurdur

Bu prompt'u Claude Code'a yapıştır. Terminalde de olur, Desktop uygulamasının Code sekmesinde de:

```text
https://github.com/MrMirhan/claude-buddy-chat adresindeki buddy-chat plugin'ini kurmak istiyorum. README'yi oku ve plugin'in ne yaptığına bak. Bulduklarını bana söyle, sonra README'de yazdığı gibi kur.
```

Claude önce repoyu okur, sonra kurulum komutunu çalıştırmadan önce izin ister.

### Kendin kur

Terminaldeki bir oturumun isteminde:

```
/plugin install buddy-chat --marketplace MrMirhan/claude-buddy-chat
```

Kabuktan:

```bash
claude plugin install buddy-chat --marketplace MrMirhan/claude-buddy-chat
```

Claude Code marketplace'i eklemek isteyip istemediğini sorar. `y` de, sonra user kapsamını seç.

Ya da önce marketplace'i ekle, sonra plugin'i oradan kur:

```
/plugin marketplace add MrMirhan/claude-buddy-chat
/plugin install buddy-chat@claude-buddy-chat
```

Desktop uygulamasında `/plugin` çalışmaz. Orada istem kutusunun yanındaki **+** → **Plugins** → **Add marketplace** ile `MrMirhan/claude-buddy-chat` ekle, sonra **Add plugin** seç.

Kabuktan kurarken açık bir oturum varsa, o oturumda `/reload-plugins` çalıştır.

## Başlarken

1. `/buddy` paneli açar.
2. Adını ve kullanıcı adını belirle.
3. **Ekleme satırını kopyala**'ya bas, satırı arkadaşına herhangi bir uygulamadan gönder.
4. Arkadaşın satırı kendi panelindeki **Kişi ekle** alanına yapıştırır. Sana arkadaşlık isteği gelir.
5. **Kişiler** sekmesinde **Kabul et**'e bas. Sohbet açılır.

İkinizin de buddy-chat kurmuş olması gerekir.

## Panel

Panelin üç görünümü var. **Sohbetler** konuşmalarını listeler ve açar. **Kişiler**'de ekleme satırın, arkadaş ekleme, istekler, arkadaşlar, gruplar ve engellenenler var. **Ayarlar**'da profilin, gizlilik ve bildirim ayarları, dil, cihazlar, kurtarma ve yedek ile sürüm numarası var.

**Desktop ve VS Code**

- Geniş panelde sohbet listesi ana sayfanın yanında durur. Listede renkli avatar, son mesaj, saat ve okunmamış sayısı görünür. 5'ten fazla sohbet varsa bir arama alanı listeyi süzer. **Kişiler** ve **Ayarlar** listenin altında.
- Açık sohbette başlık üstte, yazı alanı altta sabit kalır; mesajlar ikisinin arasında kayar. Fare tekerleği ya da trackpad ile kaydır, ya da **eski mesajlar** ve **yeni mesajlar**'ı seç. Claude Code deposundaki en eski mesajın da ötesine geçince daha eski mesajlar geçmiş dosyalarından geri gelir. `←` listeye döner.
- Senin mesajların sağda turuncu balonlarda, durumlarıyla birlikte: ◷ gönderiliyor, ✓ gönderildi, ✓✓ iletildi, mavi ✓✓ okundu. Gelenler solda gri balonlarda. Bir mesajın üzerine gelince işlemleri altındaki satırda görünür.
- `+` ile 3 MB'a kadar dosya gönderirsin. Dosya, adı ve boyutuyla bir kart olarak görünür; **Aç** düğmesi ve ses dosyalarında ▶ vardır. `➤` yazıyı gönderir.
- Başlıktaki **Sessize al** sohbeti sessize alır ya da sesini açar. Arkadaşın yazarken adının altında "yazıyor…" görünür.

**Terminal**

- Sohbetler konuşmanın üstünde çip olarak durur, `1`-`9` ile geçilir.
- Gelen mesajların solunda gönderenin renginde bir çizgi var.
- `i` yazı alanına geçer. Gönderdikten sonra odak alanda kalır; `Tab` ile alandan çıkılır, `Esc` isteme döner.
- Sohbet paneli doldurur: sohbetler üstte, yazı alanı ve tuş ipuçları en altta sabit kalır.
- `k` bir üstteki mesajı, `j` bir alttakini işaretler; mesajlar işaretle birlikte kayar. İşaretli mesajda `e` düzenler, `x` siler, `c` kopyalar, `f` Claude'a iletir.
- `o` ya da **eski mesajlar** 8 mesaj geri gider, **yeni mesajlar** geri döndürür.
- `a` dosya gönderir, `m` sohbeti sessize alır.
- `Ctrl+X` sonra `Tab` paneli odaklar, `Ctrl+X` sonra `X` kapatır. Butonlara fareyle tıklamak terminalde sadece fullscreen görünümde çalışır.

**Her yerde**

- `⧉` mesajı kopyalar. `✎` mesajını düzenler, `✕` herkesten siler.
- `↗ Claude'a ilet` gelen mesajı Claude'a iletir; mesajın senden değil arkadaşından geldiği notuyla. Dosyalarda Claude, dosyanın kaydedildiği yolu da alır.
- `s` **Sohbetler**'i, `p` **Kişiler**'i, `g` **Ayarlar**'ı açar.
- Bir oturum biterken açık olan panel, bir sonraki oturumda yeniden açılır. Bunu durdurmak için paneli elle kapat.

## Komutlar

| Komut | Ne yapar |
| --- | --- |
| `/buddy` | Paneli aç |
| `/buddy-id` | Ekleme satırını göster |
| `/buddy-add <id> [takma ad]` | Arkadaşlık isteği gönder ya da gelen isteği kabul et |
| `/buddy-name <ad soyad>` | Görünen adını ayarla |
| `/buddy-username <kullanıcıadı>` | Kullanıcı adını ayarla |
| `/buddy-list` | Arkadaşları, istekleri, grupları ve engellenenleri listele |
| `/buddy-send <kişi ya da grup> <mesaj>` | Mesaj gönder |
| `/buddy-group <ad> <kişi1> [kişi2 ...]` | Grup kur |
| `/buddy-lang <en ya da tr>` | Dili ayarla |
| `/buddy-backup [klasör \| off \| now \| load <klasör>]` | Şifreli yerel yedeği aç, kapat, şimdi yedekle ya da bir yedek yükle |
| `/buddy-link [kod]` | Kodsuz: yeni cihazda bir kod göster. Kodla: o cihazı hesabına bağla |

Bir kişiyi takma adıyla, görünen adıyla ya da `@kullanıcıadı` ile anabilirsin.

## Dil

Varsayılan dil İngilizce. Türkçe için `/buddy-lang tr` çalıştır ya da **Ayarlar**'da **Türkçe**'yi seç. Panel hemen değişir. Komut açıklamaları Claude Code'un bir sonraki açılışında değişir.

## Claude ve buddy-chat

- Claude'dan mesaj göndermesini isteyebilirsin, örneğin "Ayşe'ye geç kalacağımı yaz". Claude `send_to_buddy` aracını kullanır. Mesaj bir pencerede gösterilir ve sadece **Gönder**'i seçersen gider.
- Claude mesajlarını okuyamaz. Bir mesajı sadece sen `↗`'ye basınca görür.
- Pakette gelen skill, Claude'a iletilen mesajı başka birinden gelen veri olarak görmesini ve içindeki talimatları senin onayın olmadan uygulamamasını söyler.

## Nasıl çalışır

- **Kimlik.** İlk açılışta buddy-chat bilgisayarında 16 rastgele bayt üretir; 12 kurtarma kelimen bunları taşır. Bir X25519 ve bir ML-KEM-768 anahtar çifti bu baytlardan üretilir. ID'n X25519 açık anahtarın; paylaşmak sorun değil. Gizli anahtarlar bilgisayarında, Claude Code'un plugin kaydında durur.
- **Gelen kutusu.** Her ID'nin, ID'nin hash'inden türeyen bir ntfy.sh topic'i var. Gönderirken buddy-chat şifreli zarfı alıcının topic'ine bırakır. Her bilgisayarda bir oturum o bilgisayar adına mesaj alır. Bu oturum `curl` ile topic'e açık bir bağlantı tutar; ntfy.sh her mesajı geldiği anda iletir. `curl` yoksa topic'i 8 saniyede bir yoklar. Diğer açık oturumlar ortak kayıttan okur.
- **Şifreleme.** El sıkışma bitmeden her mesaj `nacl.box` (X25519 ve XSalsa20-Poly1305) ile şifrelenir. Sadece alıcı açabilir ve kimin gönderdiğini bilir.
- **Kuantuma dayanıklılık.** İki kişi arkadaş olunca plugin'leri kendiliğinden bir ML-KEM-768 (FIPS 203) el sıkışması yapar. Ondan sonra her mesajın anahtarı X25519 ve ML-KEM sırlarının ikisinden türer; Signal'in PQXDH'ı ve Apple'ın iMessage PQ3'ü de bu yaklaşımı kullanır. Bugün kaydedilen trafik ileride bir kuantum bilgisayarla çözülemez. ML-KEM kodunda bir hata çıksa bile X25519 korumaya devam eder. El sıkışmadan sonra o arkadaştan gelen klasik şifreli içerik reddedilir. **Kişiler** sekmesinde el sıkışması biten arkadaşın yanında `PQ` yazar.
- **İstekler.** Arkadaşın olmayan birinin mesajı düşer. İstek ve kabul de şifreli ve imzalıdır. En fazla 50 açık istek tutulur; ondan sonra yeni kişilerin istekleri düşer, böylece uydurma ID'ler depolamayı dolduramaz.
- **Tekrar oynatma.** Her şifreli mesaj kime gittiğini ve ne zaman gönderildiğini taşır. buddy-chat başkasına gönderilmiş bir mesajı (göndericisine geri yollanmış bir kopyayı), 36 saatten eski bir mesajı ve daha önce aldığı bir mesajı düşürür. 0.21'den eski bir sürümdeki arkadaş zaman göndermez; onun mesajları, zaman taşıyan ilk mesajına kadar alınır.
- **Gruplar.** Her grup mesajı her üyeye ayrı şifrelenip gönderilir. Arkadaşın olan üyelere kuantuma dayanıklı anahtarla, olmayanlara X25519 ile. Üyeleri sadece grubu kuran değiştirebilir.
- **Düzenleme ve silme.** Değişikliği arkadaşının plugin'i uygular. Ekran görüntüsünü ya da değiştirilmiş bir istemciyi geri alamaz.
- **Dosyalar.** Bir dosya kendine ait bir anahtarla (XSalsa20-Poly1305) şifrelenir ve ntfy.sh'a ek olarak bırakılır. Ona işaret eden mesaj bu anahtarı taşır ve her mesaj gibi her alıcı için ayrı şifrelenir; ntfy.sh sadece şifreli baytları görür. Alıcının plugin'i dosyayı indirir, çözer ve `~/Downloads/buddy-chat/` altına kaydeder. Tarayıcıdan indirilen dosyalardaki işareti alır (macOS'ta karantina, Windows'ta Mark of the Web); içindeki bir şey çalışmadan önce sistem sorar. Sadece resim, video, ses, PDF ve düz metin dosyalarında **Aç** çıkar; uygulama, betik ya da arşiv gibi diğer her dosyada **Klasörde göster** çıkar. Dosya adındaki yön işaretleri ve sondaki noktalar silinir, böylece `gnp.exe` kendini `exe.png` gibi gösteremez.
- **Okundu bilgisi ve yazıyor.** İletildi ve okundu bilgileri ile yazıyor sinyali de şifreli mesajdır. Bir bilgi, sadece mesajın gittiği kişiden geldiyse sayılır.
- **Yeniden gönderme.** Okundu bilgisi gönderen bir sürümdeki arkadaş bir mesajı onaylamazsa buddy-chat onu 11 saatte bir, en fazla 7 gün boyunca yeniden gönderir. Arkadaşının plugin'i zaten aldığı kopyayı atar.
- **Bağlı cihazlar.** Yeni cihazda **Ayarlar → Cihazlar → Yeni cihaz bu**'yu seç (ya da `/buddy-link` çalıştır). Kodu hesabının olduğu cihaza yapıştır. O cihaz anahtarlarını, kişilerini, gruplarını, ayarlarını ve son mesajlarını koddan türeyen bir anahtarla şifreler ve sadece kodun bildiği bir topic'e bırakır. Yeni cihaz bunları açar ve aynı kimliği kullanır. Sonrasında her cihaz değişenlerin (gönderilen mesajlar, düzenlemeler, kişiler, ayarlar) şifreli bir kopyasını kendi topic'ine bırakır. 5 dakikadan uzun ortada olmayan bir cihaz kaçırdıklarını diğerlerinden ister. ML-KEM el sıkışmalarını kimliği ilk oluşturan cihaz yapar; iki cihaz yapsa iki farklı anahtar çıkar.
- **Cihaz yönetimi.** **Ayarlar → Cihazlar** bağlı cihazları bilgisayar adıyla listeler; ana cihazı ve her birinin son görülme zamanını gösterir. Ana cihazda **Çıkar**, diğer cihazdan hesabı silmesini ister; cihaz bunu bir sonraki çevrimiçi olduğunda yapar. Bağlı bir cihazda **Bu cihazı ayır**, oradaki hesabı siler ve yeni bir kimlikle baştan başlar.

## Kurtarma ve yedek

**Ayarlar → Kurtarma ve yedek**, bir onaydan sonra kurtarma kelimelerini gösterir. Onları kâğıda yaz. Yeni ya da formatlanmış bir bilgisayarda aynı karta yaz; Buddy ID'n geri gelir, arkadaşların seni kaybetmez. 0.17 ve sonrasında oluşan hesapların 12 kelimesi var; daha eski hesapların anahtarı kelimelerden üretilmediği için 24 kelimesi var. Kelimeler hiçbir komuttan geçmez, çünkü isteme yazılan her şey konuşma kaydında kalır.

Kelimeler kişileri ve mesajları içermez. Onlar için aynı karttaki **Yedek klasörü seç…** düğmesiyle sistemin klasör seçme penceresini aç ya da `/buddy-backup <klasör>` çalıştır. buddy-chat orada bir `buddy-chat-<id>` klasörü tutar ve bir şey değiştiyse 10 dakikada bir günceller: kişileri, grupları, ayarları ve son mesajları içeren `account.backup`, ve eski mesaj dosyalarının her birinin şifreli bir kopyası. Her dosya gizli anahtarından türeyen bir anahtarla şifrelenir; sadece kurtarma kelimelerin açar. Geri yüklemeden sonra **Yedek yükle…** ile klasörü seç ya da `/buddy-backup load <klasör>` çalıştır; eski mesajlar da geri gelir. Kullanılan bir hesaba yedek yüklemek, yedekte olanı ekler ve yedekten sonra geleni korur. Klasör seçene kadar yedek kapalıdır. Bir bulut sürücünün eşitlediği klasör de olur.

## Güvenlik sınırları

- **Forward secrecy yok.** Signal'deki Double Ratchet gibi bir mekanizma yok. Gizli anahtarların bilgisayarından çalınırsa ntfy.sh'ta hâlâ duran mesajlar, yani en fazla son 12 saatinkiler, çözülebilir.
- **Üst veri görünür.** ntfy.sh hangi topic'e ne zaman, hangi IP'den, ne büyüklükte mesaj geldiğini görür.
- **Kullanım sayımı.** Her kurulum abacus.jasoncameron.dev'deki herkese açık bir sayaca bir kez 1 ekler, çalıştığı her gün de o günün sayısına 1 ekler. Yanında kimlik, isim ya da mesaj gitmez; servis sadece isteği ve IP adresini görür. Toplamlar Ayarlar'da görünür, **Kullanım sayımı: kapalı** bunu durdurur.
- **Üçüncü taraf kod.** TweetNaCl.js Cure53 tarafından denetlendi. noble-post-quantum bağımsız denetimden geçmedi, sadece yazarı denetledi. buddy-chat ikisini birlikte bu yüzden kullanıyor.
- **Denetlenmedi.** buddy-chat'in kendisi güvenlik denetiminden geçmedi.
- **Kurtarma kelimeleri hesabının kendisidir.** Onlara sahip olan mesajlarını okuyup gönderebilir ve yedeklerini açabilir.
- **Bağlama kodu hesabının kendisidir.** Kodu 10 dakikalık süresi içinde ele geçiren ve relay'i 12 saat içinde okuyan biri anlık görüntüyü açabilir. Kodu sadece kendine gönder. Bağlı cihazlar tek kimliği paylaşır. **Çıkar**, diğer cihazın yerine getirdiği bir istektir: bunu yok sayacak şekilde değiştirilmiş bir cihaz anahtarları tutar. Anahtarları geri almanın tek yolu, arkadaşlarının yeniden eklemesi gereken yeni bir kimliktir.

## Sınırlar

- ntfy.sh her IP'ye 60 istek verir, sonra 5 saniyede bir istek ekler. HTTP 429 gelirse buddy-chat bir dakika bekler.
- ntfy.sh mesajları 12 saat saklar. buddy-chat onaylanmayan mesajları 7 güne kadar yeniden gönderir, ama sadece 0.10 ve sonrasındaki arkadaşlara. Daha eski sürümdeki biri 12 saat içinde oturum açmazsa mesaj kaybolur.
- Claude Code'un plugin deposu en yeni 300 mesajı tutar. Daha eskiler toplu halde `~/.claude/buddy-chat/history/` altındaki dosyalara taşınır ve bir sohbetin en üstünden yukarı kaydırınca geri gelir. Bu dosyalar şifreli değildir; yedek onların şifreli kopyalarını tutar. Bağlı bir cihaz sadece depodaki mesajları alır.
- Her grup mesajı, düzenleme ve silme üye başına bir istek harcar.
- Okundu bilgileri ve yazıyor sinyali de istek harcar. buddy-chat her mesaj grubu için tek bir bilgi, en fazla 5 saniyede bir yazıyor sinyali gönderir. Gruplarda yazıyor göstergesi yok.
- İletildi bilgisi, alıcıda Claude Code açıkken gider.
- Bir mesaj yaklaşık 2.500 karakter alır.
- Bir dosya en fazla 3 MB olabilir, çünkü mod bir dosyadan en fazla 4 MiB okuyabiliyor. ntfy.sh bir dosyayı 3 saat tutar; o sürede hiç oturum açmayan arkadaş dosyayı alamaz. Dosyayı kaydetmek için sistemin `base64` aracı (macOS, Linux) ya da PowerShell (Windows) gerekir.

## Güncelleme notları

- Özellikler için iki tarafın da uygun sürümde olması gerekir: okundu bilgisi ve yazıyor için 0.10 ve sonrası, dosyalar için 0.19 ve sonrası, bağlı cihazlar için her cihazda aynı sürüm.
- 0.21 ve sonrasına: kişiler, gruplar, mesajlar, engeller ve sessize alınanlar ilk açılışta her biri ayrı bir depolama anahtarına taşınır. Bilgisayardaki bütün Claude Code oturumlarını güncelle; eski sürümde kalan bir oturum yaptığı bir değişikliği kaybedebilir.
- 0.17 ve sonrasına: daha önce oluşmuş bir hesap anahtarlarını korur ve 24 kurtarma kelimesi alır. 0.17'den itibaren oluşan hesapların 12 kelimesi vardır.
- 0.4'ten 0.5 ve sonrasına: bütün veriler kalır. İki taraf da 0.5 veya sonrasına geçince PQ el sıkışması yapılır.
- 0.3'ten: anahtarların ve arkadaşların kalır. Arkadaşlarına verdiğin adlar takma ad olur.
- 0.1 ya da 0.2'den: eski veriler silinir, yeni bir ID oluşur.

## Geliştirme

```bash
claude --plugin-dir .
```

Testler ve kontroller repo kökünden çalışır:

```bash
claude plugin test .
```

```bash
claude plugin validate .
```

Claude Code mod'u bir kez yükleyince API tiplerini `.claude-plugin/types/` altına yazar. Ondan sonra `npx tsc -p .` hooks ve testlerin tiplerini kontrol eder.

Kod `hooks/register.tsx` dosyasında. Her dilin metinleri `hooks/i18n.ts` içinde. Yeni bir dil eklemek için `hooks/i18n.ts`'ye bir tablo ekle, kodunu `LANGS` ve `LANG_NAMES`'e yaz.

## Lisans

MIT. Bkz. [LICENSE](LICENSE). `hooks/vendor/` altındaki kod kendi lisanslarını korur. Bkz. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
