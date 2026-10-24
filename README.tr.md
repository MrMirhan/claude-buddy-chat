# claude-buddy-chat

[English](README.md)

Claude Code kullanıcıları arasında uçtan uca şifreli sohbet: birebir ve grup. Anahtar anlaşması kuantuma dayanıklı. buddy-chat'in bir sunucusu yok: şifreli zarfları ücretsiz ve herkese açık ntfy.sh taşır, zarfı sadece alıcı açabilir.

buddy-chat bir Claude Code [mod'u](https://code.claude.com/docs/en/plugins/mods/overview.md). Bir panel, komutlar, Claude için bir araç ve Claude'a bunların nasıl kullanılacağını anlatan bir skill ekler.

## Özellikler

- Birebir mesaj ve en fazla 8 kişilik gruplar
- Karşı tarafın onayladığı arkadaşlık istekleri
- Arkadaşlarının gördüğü bir ad ve kullanıcı adı; sadece senin gördüğün takma adlar
- Kendi mesajını herkesten düzenleme ve silme; her mesajı kopyalama
- Mesaj durumları: gönderiliyor ◷, gönderildi ✓, iletildi ✓✓, okundu (mavi ✓✓)
- Birebir sohbetlerde "yazıyor…" göstergesi
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

Panel her yüzeyde aynı, ama her uygulama kendi görünümüyle çizer.

**Desktop ve VS Code**

- Geniş panelde sohbet listesi ana sayfanın yanında durur: Buddy ID'n, arkadaş ekleme ve istekler. Sohbete tıklayınca açılır.
- Açık sohbet tüm paneli kaplar ve fare tekerleği ya da trackpad ile kayar. En yeni mesajda açılır, son 40 mesajı gösterir. En üstteki **eski mesajlar** 20 mesaj daha yükler. `←` listeye döner.
- Sohbet listesinde renkli avatar, son mesaj, saat ve okunmamış sayısı görünür. 5'ten fazla sohbet varsa bir arama alanı listeyi süzer.
- Senin mesajların sağda turuncu balonlarda, gelenler solda gri balonlarda. Mesajın işlemleri, üzerine gelince görünür.
- **Kişiler** sekmesinde profil kartın, istekler, arkadaşlar, gruplar ve engellenenler var.

**Terminal**

- Sohbetler konuşmanın üstünde çip olarak durur, `1`-`9` ile geçilir.
- Gelen mesajların solunda gönderenin renginde bir çizgi var.
- `i` yazı alanına geçer. Gönderdikten sonra odak alanda kalır; `Tab` ile alandan çıkılır, `Esc` isteme döner.
- Sohbet paneli doldurur: sohbetler üstte, yazı alanı ve tuş ipuçları en altta sabit kalır.
- `k` bir üstteki mesajı, `j` bir alttakini işaretler; mesajlar işaretle birlikte kayar. İşaretli mesajda `e` düzenler, `x` siler, `f` Claude'a iletir.
- `o` ya da **eski mesajlar** 8 mesaj geri gider, **yeni mesaj** geri döndürür.
- `Ctrl+X` sonra `Tab` paneli odaklar, `Ctrl+X` sonra `X` kapatır. Butonlara fareyle tıklamak terminalde sadece fullscreen görünümde çalışır.

**Her yerde**

- `✎` mesajını düzenler, `✕` herkesten siler.
- `↗` gelen mesajı Claude'a iletir; mesajın senden değil arkadaşından geldiği notuyla.
- Terminalde sohbet paneli doldurur: sohbetler üstte, yazı alanı en altta kalır. **Eski mesajlar** ve **yeni mesaj** butonlarıyla sayfa sayfa gezilir.
- `s` **Sohbetler**'i, `p` **Kişiler**'i açar.

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
| `/buddy-backup [klasör \| off \| now \| load <dosya>]` | Şifreli yerel yedeği aç, kapat, şimdi yedekle ya da bir yedek yükle |
| `/buddy-link [kod]` | Kodsuz: yeni cihazda bir kod göster. Kodla: o cihazı hesabına bağla |

Bir kişiyi takma adıyla, görünen adıyla ya da `@kullanıcıadı` ile anabilirsin.

## Dil

Varsayılan dil İngilizce. Türkçe için `/buddy-lang tr` çalıştır ya da **Kişiler** sekmesinde **Türkçe**'yi seç. Panel hemen değişir. Komut açıklamaları Claude Code'un bir sonraki açılışında değişir.

## Claude ve buddy-chat

- Claude'dan mesaj göndermesini isteyebilirsin, örneğin "Ayşe'ye geç kalacağımı yaz". Claude `send_to_buddy` aracını kullanır. Mesaj bir pencerede gösterilir ve sadece **Gönder**'i seçersen gider.
- Claude mesajlarını okuyamaz. Bir mesajı sadece sen `↗`'ye basınca görür.
- Pakette gelen skill, Claude'a iletilen mesajı başka birinden gelen veri olarak görmesini ve içindeki talimatları senin onayın olmadan uygulamamasını söyler.

## Nasıl çalışır

- **Kimlik.** İlk açılışta buddy-chat bilgisayarında bir X25519 ve bir ML-KEM-768 anahtar çifti üretir. ID'n X25519 açık anahtarın; paylaşmak sorun değil. Gizli anahtarlar bilgisayarında, Claude Code'un plugin kaydında durur.
- **Gelen kutusu.** Her ID'nin, ID'nin hash'inden türeyen bir ntfy.sh topic'i var. Gönderirken buddy-chat şifreli zarfı alıcının topic'ine bırakır. Her bilgisayarda bir oturum o bilgisayar adına mesaj alır. Bu oturum `curl` ile topic'e açık bir bağlantı tutar; ntfy.sh her mesajı geldiği anda iletir. `curl` yoksa topic'i 8 saniyede bir yoklar. Diğer açık oturumlar ortak kayıttan okur.
- **Şifreleme.** El sıkışma bitmeden her mesaj `nacl.box` (X25519 ve XSalsa20-Poly1305) ile şifrelenir. Sadece alıcı açabilir ve kimin gönderdiğini bilir.
- **Kuantuma dayanıklılık.** İki kişi arkadaş olunca plugin'leri kendiliğinden bir ML-KEM-768 (FIPS 203) el sıkışması yapar. Ondan sonra her mesajın anahtarı X25519 ve ML-KEM sırlarının ikisinden türer; Signal'in PQXDH'ı ve Apple'ın iMessage PQ3'ü de bu yaklaşımı kullanır. Bugün kaydedilen trafik ileride bir kuantum bilgisayarla çözülemez. ML-KEM kodunda bir hata çıksa bile X25519 korumaya devam eder. El sıkışmadan sonra o arkadaştan gelen klasik şifreli içerik reddedilir. **Kişiler** sekmesinde el sıkışması biten arkadaşın yanında `PQ` yazar.
- **İstekler.** Arkadaşın olmayan birinin mesajı düşer. İstek ve kabul de şifreli ve imzalıdır.
- **Gruplar.** Her grup mesajı her üyeye ayrı şifrelenip gönderilir. Arkadaşın olan üyelere kuantuma dayanıklı anahtarla, olmayanlara X25519 ile. Üyeleri sadece grubu kuran değiştirebilir.
- **Düzenleme ve silme.** Değişikliği arkadaşının plugin'i uygular. Ekran görüntüsünü ya da değiştirilmiş bir istemciyi geri alamaz.
- **Okundu bilgisi ve yazıyor.** İletildi ve okundu bilgileri ile yazıyor sinyali de şifreli mesajdır. Bir bilgi, sadece mesajın gittiği kişiden geldiyse sayılır.
- **Yeniden gönderme.** Okundu bilgisi gönderen bir sürümdeki arkadaş bir mesajı onaylamazsa buddy-chat onu 11 saatte bir, en fazla 7 gün boyunca yeniden gönderir. Arkadaşının plugin'i zaten aldığı kopyayı atar.
- **Bağlı cihazlar.** Yeni cihazda **Kişiler → Cihazlar → Yeni cihaz bu**'yu seç (ya da `/buddy-link` çalıştır). Kodu hesabının olduğu cihaza yapıştır. O cihaz anahtarlarını, kişilerini, gruplarını, ayarlarını ve son mesajlarını koddan türeyen bir anahtarla şifreler ve sadece kodun bildiği bir topic'e bırakır. Yeni cihaz bunları açar ve aynı kimliği kullanır. Sonrasında her cihaz değişenlerin (gönderilen mesajlar, düzenlemeler, kişiler, ayarlar) şifreli bir kopyasını kendi topic'ine bırakır. 5 dakikadan uzun ortada olmayan bir cihaz kaçırdıklarını diğerlerinden ister. ML-KEM el sıkışmalarını kimliği ilk oluşturan cihaz yapar; iki cihaz yapsa iki farklı anahtar çıkar.
- **Cihaz yönetimi.** **Kişiler → Cihazlar** bağlı cihazları bilgisayar adıyla listeler; ana cihazı ve her birinin son görülme zamanını gösterir. Ana cihazda **Çıkar**, diğer cihazdan hesabı silmesini ister; cihaz bunu bir sonraki çevrimiçi olduğunda yapar. Bağlı bir cihazda **Bu cihazı ayır**, oradaki hesabı siler ve yeni bir kimlikle baştan başlar.

## Kurtarma ve yedek

**Kişiler → Kurtarma ve yedek**, bir onaydan sonra kurtarma kelimelerini gösterir. Onları kâğıda yaz. Yeni ya da formatlanmış bir bilgisayarda aynı karta yaz; Buddy ID'n geri gelir, arkadaşların seni kaybetmez. 0.17 ve sonrasında oluşan hesapların 12 kelimesi var; daha eski hesapların anahtarı kelimelerden üretilmediği için 24 kelimesi var. Kelimeler hiçbir komuttan geçmez, çünkü isteme yazılan her şey konuşma kaydında kalır.

Kelimeler kişileri ve mesajları içermez. Onlar için aynı kartta ya da `/buddy-backup <klasör>` ile bir yedek klasörü seç. buddy-chat bir şey değiştiyse 10 dakikada bir oraya `buddy-chat-<id>.backup` yazar. Dosya gizli anahtarından türeyen bir anahtarla şifrelenir; sadece kurtarma kelimelerin açar. Geri yüklemeden sonra dosyayı kartta ya da `/buddy-backup load <dosya>` ile yükle. Klasör seçene kadar yedek kapalıdır. Bir bulut sürücünün eşitlediği klasör de olur.

## Güvenlik sınırları

- **Forward secrecy yok.** Signal'deki Double Ratchet gibi bir mekanizma yok. Gizli anahtarların bilgisayarından çalınırsa ntfy.sh'ta hâlâ duran mesajlar, yani en fazla son 12 saatinkiler, çözülebilir.
- **Üst veri görünür.** ntfy.sh hangi topic'e ne zaman, hangi IP'den, ne büyüklükte mesaj geldiğini görür.
- **Üçüncü taraf kod.** TweetNaCl.js Cure53 tarafından denetlendi. noble-post-quantum bağımsız denetimden geçmedi, sadece yazarı denetledi. buddy-chat ikisini birlikte bu yüzden kullanıyor.
- **Denetlenmedi.** buddy-chat'in kendisi güvenlik denetiminden geçmedi.
- **Kurtarma kelimeleri hesabının kendisidir.** Onlara sahip olan mesajlarını okuyup gönderebilir ve yedeklerini açabilir.
- **Bağlama kodu hesabının kendisidir.** Kodu 10 dakikalık süresi içinde ele geçiren ve relay'i 12 saat içinde okuyan biri anlık görüntüyü açabilir. Kodu sadece kendine gönder. Bağlı cihazlar tek kimliği paylaşır. **Çıkar**, diğer cihazın yerine getirdiği bir istektir: bunu yok sayacak şekilde değiştirilmiş bir cihaz anahtarları tutar. Anahtarları geri almanın tek yolu, arkadaşlarının yeniden eklemesi gereken yeni bir kimliktir.

## Sınırlar

- ntfy.sh her IP'ye 60 istek verir, sonra 5 saniyede bir istek ekler. HTTP 429 gelirse buddy-chat bir dakika bekler.
- ntfy.sh mesajları 12 saat saklar. buddy-chat onaylanmayan mesajları 7 güne kadar yeniden gönderir, ama sadece 0.10 ve sonrasındaki arkadaşlara. Daha eski sürümdeki biri 12 saat içinde oturum açmazsa mesaj kaybolur.
- Claude Code'un plugin deposu en yeni 300 mesajı tutar. Daha eskiler toplu halde `~/.claude/buddy-chat/history/` altındaki dosyalara taşınır ve bir sohbetin en üstünden yukarı kaydırınca geri gelir. Bu dosyalar şifreli değildir; bağlı bir cihaz sadece depodaki mesajları alır.
- Her grup mesajı, düzenleme ve silme üye başına bir istek harcar.
- Okundu bilgileri ve yazıyor sinyali de istek harcar. buddy-chat her mesaj grubu için tek bir bilgi, en fazla 5 saniyede bir yazıyor sinyali gönderir. Gruplarda yazıyor göstergesi yok.
- İletildi bilgisi, alıcıda Claude Code açıkken gider.

## Güncelleme notları

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
