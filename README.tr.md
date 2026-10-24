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
- Okundu bilgisi ve yazıyor göstergesi için gizlilik ayarları. Okundu bilgisi kapalıyken ne gönderirsin ne görürsün.
- Arkadaşlıktan çıkarma (karşı taraf bilgilendirilir) ve engelleme (bilgilendirilmez)
- Yeni mesaj ve istekler için toast ve işletim sistemi bildirimi
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

## Güvenlik sınırları

- **Forward secrecy yok.** Signal'deki Double Ratchet gibi bir mekanizma yok. Gizli anahtarların bilgisayarından çalınırsa ntfy.sh'ta hâlâ duran mesajlar, yani en fazla son 12 saatinkiler, çözülebilir.
- **Üst veri görünür.** ntfy.sh hangi topic'e ne zaman, hangi IP'den, ne büyüklükte mesaj geldiğini görür.
- **Üçüncü taraf kod.** TweetNaCl.js Cure53 tarafından denetlendi. noble-post-quantum bağımsız denetimden geçmedi, sadece yazarı denetledi. buddy-chat ikisini birlikte bu yüzden kullanıyor.
- **Denetlenmedi.** buddy-chat'in kendisi güvenlik denetiminden geçmedi.

## Sınırlar

- ntfy.sh her IP'ye 60 istek verir, sonra 5 saniyede bir istek ekler. HTTP 429 gelirse buddy-chat bir dakika bekler.
- ntfy.sh mesajları 12 saat saklar. O süre içinde hiç oturum açmayan kişiye mesaj ulaşmaz.
- Bir mesaj yaklaşık 2.500 karakter alır.
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
