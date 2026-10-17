-- Private derivative index. Version 1 indexes user-authored text only;
-- computed Owner/Verification metadata, proofs, attachments and extension JSON
-- are excluded. No original entities, revisions, grants or Auth users are changed.
CREATE TABLE fountain_private.content_search_documents (
 workspace_id text NOT NULL,kind text NOT NULL CHECK(kind IN('page','database','row')),id text NOT NULL,
 generation text NOT NULL CHECK(generation ~ '^[a-f0-9]{32}$'),title text NOT NULL,title_fold text NOT NULL,id_fold text NOT NULL,
 icon text,header jsonb NOT NULL,created_at text,updated_at text,text_revision text NOT NULL CHECK(text_revision ~ '^[a-f0-9]{64}$'),
 validity boolean NOT NULL,error text,PRIMARY KEY(workspace_id,kind,id));
CREATE TABLE fountain_private.content_search_chunks (
 workspace_id text NOT NULL,kind text NOT NULL,id text NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 text_value text NOT NULL,folded_value text NOT NULL,PRIMARY KEY(workspace_id,kind,id,ordinal),
 FOREIGN KEY(workspace_id,kind,id) REFERENCES fountain_private.content_search_documents(workspace_id,kind,id) ON DELETE CASCADE);
CREATE TABLE fountain_private.content_provenance (
 workspace_id text NOT NULL,kind text NOT NULL,id text NOT NULL,generation text NOT NULL,
 creator_id text,creator_cause text NOT NULL,editor_id text,edited_at text,editor_cause text NOT NULL,
 manager_id text,manager_at text,PRIMARY KEY(workspace_id,kind,id),
 FOREIGN KEY(workspace_id,kind,id) REFERENCES fountain_private.content_search_documents(workspace_id,kind,id) ON DELETE CASCADE);
CREATE TABLE fountain_private.content_search_state (
 workspace_id text PRIMARY KEY,index_version integer NOT NULL CHECK(index_version=1),
 content_revision bigint NOT NULL CHECK(content_revision BETWEEN 0 AND 9007199254740991),ready boolean NOT NULL,cursor_secret text NOT NULL DEFAULT(replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')) CHECK(cursor_secret ~ '^[a-f0-9]{64}$'));
ALTER TABLE fountain_private.content_search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.content_search_documents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.content_search_documents FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.content_search_documents TO fountain_backend;
CREATE POLICY content_search_documents_workspace ON fountain_private.content_search_documents FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.content_search_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.content_search_chunks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.content_search_chunks FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.content_search_chunks TO fountain_backend;
CREATE POLICY content_search_chunks_workspace ON fountain_private.content_search_chunks FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.content_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.content_provenance FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.content_provenance FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.content_provenance TO fountain_backend;
CREATE POLICY content_provenance_workspace ON fountain_private.content_provenance FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.content_search_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.content_search_state FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.content_search_state FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.content_search_state TO fountain_backend;
CREATE POLICY content_search_state_workspace ON fountain_private.content_search_state FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));

CREATE FUNCTION fountain_private.content_display(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
 SELECT btrim(regexp_replace(normalize(p_value,NFKC),E'[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+',' ','g'),' ')
$f$;
-- Full Unicode 15 casefold matches the existing 1530-entry Access table.
-- Single-codepoint mappings use native translate; only expansion characters
-- split runs. ASCII/ordinary prose takes the native translate fast path.
CREATE FUNCTION fountain_private.content_casefold(p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
DECLARE v_value text:=translate(p_value,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');v_folded text;
 v_from constant text:='µÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠƢƤƦƧƩƬƮƯƱƲƳƵƷƸƼǄǅǇǈǊǋǍǏǑǓǕǗǙǛǞǠǢǤǦǨǪǬǮǱǲǴǶǷǸǺǼǾȀȂȄȆȈȊȌȎȐȒȔȖȘȚȜȞȠȢȤȦȨȪȬȮȰȲȺȻȽȾɁɃɄɅɆɈɊɌɎͅͰͲͶͿΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫςϏϐϑϕϖϘϚϜϞϠϢϤϦϨϪϬϮϰϱϴϵϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯѠѢѤѦѨѪѬѮѰѲѴѶѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӃӅӇӉӋӍӐӒӔӖӘӚӜӞӠӢӤӦӨӪӬӮӰӲӴӶӸӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍᏸᏹᏺᏻᏼᏽᲀᲁᲂᲃᲄᲅᲆᲇᲈᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẛẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾἈἉἊἋἌἍἎἏἘἙἚἛἜἝἨἩἪἫἬἭἮἯἸἹἺἻἼἽἾἿὈὉὊὋὌὍὙὛὝὟὨὩὪὫὬὭὮὯᾸᾹᾺΆιῈΈῊΉῘῙῚΊῨῩῪΎῬῸΌῺΏΩKÅℲⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯↃⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟐꟖꟘꟵꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇𐐈𐐉𐐊𐐋𐐌𐐍𐐎𐐏𐐐𐐑𐐒𐐓𐐔𐐕𐐖𐐗𐐘𐐙𐐚𐐛𐐜𐐝𐐞𐐟𐐠𐐡𐐢𐐣𐐤𐐥𐐦𐐧𐒰𐒱𐒲𐒳𐒴𐒵𐒶𐒷𐒸𐒹𐒺𐒻𐒼𐒽𐒾𐒿𐓀𐓁𐓂𐓃𐓄𐓅𐓆𐓇𐓈𐓉𐓊𐓋𐓌𐓍𐓎𐓏𐓐𐓑𐓒𐓓𐕰𐕱𐕲𐕳𐕴𐕵𐕶𐕷𐕸𐕹𐕺𐕼𐕽𐕾𐕿𐖀𐖁𐖂𐖃𐖄𐖅𐖆𐖇𐖈𐖉𐖊𐖌𐖍𐖎𐖏𐖐𐖑𐖒𐖔𐖕𐲀𐲁𐲂𐲃𐲄𐲅𐲆𐲇𐲈𐲉𐲊𐲋𐲌𐲍𐲎𐲏𐲐𐲑𐲒𐲓𐲔𐲕𐲖𐲗𐲘𐲙𐲚𐲛𐲜𐲝𐲞𐲟𐲠𐲡𐲢𐲣𐲤𐲥𐲦𐲧𐲨𐲩𐲪𐲫𐲬𐲭𐲮𐲯𐲰𐲱𐲲𑢠𑢡𑢢𑢣𑢤𑢥𑢦𑢧𑢨𑢩𑢪𑢫𑢬𑢭𑢮𑢯𑢰𑢱𑢲𑢳𑢴𑢵𑢶𑢷𑢸𑢹𑢺𑢻𑢼𑢽𑢾𑢿𖹀𖹁𖹂𖹃𖹄𖹅𖹆𖹇𖹈𖹉𖹊𖹋𖹌𖹍𖹎𖹏𖹐𖹑𖹒𖹓𖹔𖹕𖹖𖹗𖹘𖹙𖹚𖹛𖹜𖹝𖹞𖹟𞤀𞤁𞤂𞤃𞤄𞤅𞤆𞤇𞤈𞤉𞤊𞤋𞤌𞤍𞤎𞤏𞤐𞤑𞤒𞤓𞤔𞤕𞤖𞤗𞤘𞤙𞤚𞤛𞤜𞤝𞤞𞤟𞤠𞤡';
 v_to constant text:='μàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįĳĵķĺļľŀłńņňŋōŏőœŕŗřśŝşšţťŧũūŭůűųŵŷÿźżžsɓƃƅɔƈɖɗƌǝəɛƒɠɣɩɨƙɯɲɵơƣƥʀƨʃƭʈưʊʋƴƶʒƹƽǆǆǉǉǌǌǎǐǒǔǖǘǚǜǟǡǣǥǧǩǫǭǯǳǳǵƕƿǹǻǽǿȁȃȅȇȉȋȍȏȑȓȕȗșțȝȟƞȣȥȧȩȫȭȯȱȳⱥȼƚⱦɂƀʉʌɇɉɋɍɏιͱͳͷϳάέήίόύώαβγδεζηθικλμνξοπρστυφχψωϊϋσϗβθφπϙϛϝϟϡϣϥϧϩϫϭϯκρθεϸϲϻͻͼͽѐёђѓєѕіїјљњћќѝўџабвгдежзийклмнопрстуфхцчшщъыьэюяѡѣѥѧѩѫѭѯѱѳѵѷѹѻѽѿҁҋҍҏґғҕҗҙқҝҟҡңҥҧҩҫҭүұҳҵҷҹһҽҿӏӂӄӆӈӊӌӎӑӓӕӗәӛӝӟӡӣӥӧөӫӭӯӱӳӵӷӹӻӽӿԁԃԅԇԉԋԍԏԑԓԕԗԙԛԝԟԡԣԥԧԩԫԭԯաբգդեզէըթժիլխծկհձղճմյնշոչպջռսվտրցւփքօֆⴀⴁⴂⴃⴄⴅⴆⴇⴈⴉⴊⴋⴌⴍⴎⴏⴐⴑⴒⴓⴔⴕⴖⴗⴘⴙⴚⴛⴜⴝⴞⴟⴠⴡⴢⴣⴤⴥⴧⴭᏰᏱᏲᏳᏴᏵвдосттъѣꙋაბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰჱჲჳჴჵჶჷჸჹჺჽჾჿḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕṡạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹỻỽỿἀἁἂἃἄἅἆἇἐἑἒἓἔἕἠἡἢἣἤἥἦἧἰἱἲἳἴἵἶἷὀὁὂὃὄὅὑὓὕὗὠὡὢὣὤὥὦὧᾰᾱὰάιὲέὴήῐῑὶίῠῡὺύῥὸόὼώωkåⅎⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻⅼⅽⅾⅿↄⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩⰰⰱⰲⰳⰴⰵⰶⰷⰸⰹⰺⰻⰼⰽⰾⰿⱀⱁⱂⱃⱄⱅⱆⱇⱈⱉⱊⱋⱌⱍⱎⱏⱐⱑⱒⱓⱔⱕⱖⱗⱘⱙⱚⱛⱜⱝⱞⱟⱡɫᵽɽⱨⱪⱬɑɱɐɒⱳⱶȿɀⲁⲃⲅⲇⲉⲋⲍⲏⲑⲓⲕⲗⲙⲛⲝⲟⲡⲣⲥⲧⲩⲫⲭⲯⲱⲳⲵⲷⲹⲻⲽⲿⳁⳃⳅⳇⳉⳋⳍⳏⳑⳓⳕⳗⳙⳛⳝⳟⳡⳣⳬⳮⳳꙁꙃꙅꙇꙉꙋꙍꙏꙑꙓꙕꙗꙙꙛꙝꙟꙡꙣꙥꙧꙩꙫꙭꚁꚃꚅꚇꚉꚋꚍꚏꚑꚓꚕꚗꚙꚛꜣꜥꜧꜩꜫꜭꜯꜳꜵꜷꜹꜻꜽꜿꝁꝃꝅꝇꝉꝋꝍꝏꝑꝓꝕꝗꝙꝛꝝꝟꝡꝣꝥꝧꝩꝫꝭꝯꝺꝼᵹꝿꞁꞃꞅꞇꞌɥꞑꞓꞗꞙꞛꞝꞟꞡꞣꞥꞧꞩɦɜɡɬɪʞʇʝꭓꞵꞷꞹꞻꞽꞿꟁꟃꞔʂᶎꟈꟊꟑꟗꟙꟶᎠᎡᎢᎣᎤᎥᎦᎧᎨᎩᎪᎫᎬᎭᎮᎯᎰᎱᎲᎳᎴᎵᎶᎷᎸᎹᎺᎻᎼᎽᎾᎿᏀᏁᏂᏃᏄᏅᏆᏇᏈᏉᏊᏋᏌᏍᏎᏏᏐᏑᏒᏓᏔᏕᏖᏗᏘᏙᏚᏛᏜᏝᏞᏟᏠᏡᏢᏣᏤᏥᏦᏧᏨᏩᏪᏫᏬᏭᏮᏯａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ𐐨𐐩𐐪𐐫𐐬𐐭𐐮𐐯𐐰𐐱𐐲𐐳𐐴𐐵𐐶𐐷𐐸𐐹𐐺𐐻𐐼𐐽𐐾𐐿𐑀𐑁𐑂𐑃𐑄𐑅𐑆𐑇𐑈𐑉𐑊𐑋𐑌𐑍𐑎𐑏𐓘𐓙𐓚𐓛𐓜𐓝𐓞𐓟𐓠𐓡𐓢𐓣𐓤𐓥𐓦𐓧𐓨𐓩𐓪𐓫𐓬𐓭𐓮𐓯𐓰𐓱𐓲𐓳𐓴𐓵𐓶𐓷𐓸𐓹𐓺𐓻𐖗𐖘𐖙𐖚𐖛𐖜𐖝𐖞𐖟𐖠𐖡𐖣𐖤𐖥𐖦𐖧𐖨𐖩𐖪𐖫𐖬𐖭𐖮𐖯𐖰𐖱𐖳𐖴𐖵𐖶𐖷𐖸𐖹𐖻𐖼𐳀𐳁𐳂𐳃𐳄𐳅𐳆𐳇𐳈𐳉𐳊𐳋𐳌𐳍𐳎𐳏𐳐𐳑𐳒𐳓𐳔𐳕𐳖𐳗𐳘𐳙𐳚𐳛𐳜𐳝𐳞𐳟𐳠𐳡𐳢𐳣𐳤𐳥𐳦𐳧𐳨𐳩𐳪𐳫𐳬𐳭𐳮𐳯𐳰𐳱𐳲𑣀𑣁𑣂𑣃𑣄𑣅𑣆𑣇𑣈𑣉𑣊𑣋𑣌𑣍𑣎𑣏𑣐𑣑𑣒𑣓𑣔𑣕𑣖𑣗𑣘𑣙𑣚𑣛𑣜𑣝𑣞𑣟𖹠𖹡𖹢𖹣𖹤𖹥𖹦𖹧𖹨𖹩𖹪𖹫𖹬𖹭𖹮𖹯𖹰𖹱𖹲𖹳𖹴𖹵𖹶𖹷𖹸𖹹𖹺𖹻𖹼𖹽𖹾𖹿𞤢𞤣𞤤𞤥𞤦𞤧𞤨𞤩𞤪𞤫𞤬𞤭𞤮𞤯𞤰𞤱𞤲𞤳𞤴𞤵𞤶𞤷𞤸𞤹𞤺𞤻𞤼𞤽𞤾𞤿𞥀𞥁𞥂𞥃';
 v_multi constant jsonb:='{"ß":"ss","İ":"i̇","ŉ":"ʼn","ǰ":"ǰ","ΐ":"ΐ","ΰ":"ΰ","և":"եւ","ẖ":"ẖ","ẗ":"ẗ","ẘ":"ẘ","ẙ":"ẙ","ẚ":"aʾ","ẞ":"ss","ὐ":"ὐ","ὒ":"ὒ","ὔ":"ὔ","ὖ":"ὖ","ᾀ":"ἀι","ᾁ":"ἁι","ᾂ":"ἂι","ᾃ":"ἃι","ᾄ":"ἄι","ᾅ":"ἅι","ᾆ":"ἆι","ᾇ":"ἇι","ᾈ":"ἀι","ᾉ":"ἁι","ᾊ":"ἂι","ᾋ":"ἃι","ᾌ":"ἄι","ᾍ":"ἅι","ᾎ":"ἆι","ᾏ":"ἇι","ᾐ":"ἠι","ᾑ":"ἡι","ᾒ":"ἢι","ᾓ":"ἣι","ᾔ":"ἤι","ᾕ":"ἥι","ᾖ":"ἦι","ᾗ":"ἧι","ᾘ":"ἠι","ᾙ":"ἡι","ᾚ":"ἢι","ᾛ":"ἣι","ᾜ":"ἤι","ᾝ":"ἥι","ᾞ":"ἦι","ᾟ":"ἧι","ᾠ":"ὠι","ᾡ":"ὡι","ᾢ":"ὢι","ᾣ":"ὣι","ᾤ":"ὤι","ᾥ":"ὥι","ᾦ":"ὦι","ᾧ":"ὧι","ᾨ":"ὠι","ᾩ":"ὡι","ᾪ":"ὢι","ᾫ":"ὣι","ᾬ":"ὤι","ᾭ":"ὥι","ᾮ":"ὦι","ᾯ":"ὧι","ᾲ":"ὰι","ᾳ":"αι","ᾴ":"άι","ᾶ":"ᾶ","ᾷ":"ᾶι","ᾼ":"αι","ῂ":"ὴι","ῃ":"ηι","ῄ":"ήι","ῆ":"ῆ","ῇ":"ῆι","ῌ":"ηι","ῒ":"ῒ","ΐ":"ΐ","ῖ":"ῖ","ῗ":"ῗ","ῢ":"ῢ","ΰ":"ΰ","ῤ":"ῤ","ῦ":"ῦ","ῧ":"ῧ","ῲ":"ὼι","ῳ":"ωι","ῴ":"ώι","ῶ":"ῶ","ῷ":"ῶι","ῼ":"ωι","ﬀ":"ff","ﬁ":"fi","ﬂ":"fl","ﬃ":"ffi","ﬄ":"ffl","ﬅ":"st","ﬆ":"st","ﬓ":"մն","ﬔ":"մե","ﬕ":"մի","ﬖ":"վն","ﬗ":"մխ"}'::jsonb;
BEGIN
 IF v_value !~ '[µÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠƢƤƦƧƩƬƮƯƱƲƳƵƷƸƼǄǅǇǈǊǋǍǏǑǓǕǗǙǛǞǠǢǤǦǨǪǬǮǱǲǴǶǷǸǺǼǾȀȂȄȆȈȊȌȎȐȒȔȖȘȚȜȞȠȢȤȦȨȪȬȮȰȲȺȻȽȾɁɃɄɅɆɈɊɌɎͅͰͲͶͿΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫςϏϐϑϕϖϘϚϜϞϠϢϤϦϨϪϬϮϰϱϴϵϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯѠѢѤѦѨѪѬѮѰѲѴѶѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӃӅӇӉӋӍӐӒӔӖӘӚӜӞӠӢӤӦӨӪӬӮӰӲӴӶӸӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍᏸᏹᏺᏻᏼᏽᲀᲁᲂᲃᲄᲅᲆᲇᲈᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẛẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾἈἉἊἋἌἍἎἏἘἙἚἛἜἝἨἩἪἫἬἭἮἯἸἹἺἻἼἽἾἿὈὉὊὋὌὍὙὛὝὟὨὩὪὫὬὭὮὯᾸᾹᾺΆιῈΈῊΉῘῙῚΊῨῩῪΎῬῸΌῺΏΩKÅℲⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯↃⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟐꟖꟘꟵꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇𐐈𐐉𐐊𐐋𐐌𐐍𐐎𐐏𐐐𐐑𐐒𐐓𐐔𐐕𐐖𐐗𐐘𐐙𐐚𐐛𐐜𐐝𐐞𐐟𐐠𐐡𐐢𐐣𐐤𐐥𐐦𐐧𐒰𐒱𐒲𐒳𐒴𐒵𐒶𐒷𐒸𐒹𐒺𐒻𐒼𐒽𐒾𐒿𐓀𐓁𐓂𐓃𐓄𐓅𐓆𐓇𐓈𐓉𐓊𐓋𐓌𐓍𐓎𐓏𐓐𐓑𐓒𐓓𐕰𐕱𐕲𐕳𐕴𐕵𐕶𐕷𐕸𐕹𐕺𐕼𐕽𐕾𐕿𐖀𐖁𐖂𐖃𐖄𐖅𐖆𐖇𐖈𐖉𐖊𐖌𐖍𐖎𐖏𐖐𐖑𐖒𐖔𐖕𐲀𐲁𐲂𐲃𐲄𐲅𐲆𐲇𐲈𐲉𐲊𐲋𐲌𐲍𐲎𐲏𐲐𐲑𐲒𐲓𐲔𐲕𐲖𐲗𐲘𐲙𐲚𐲛𐲜𐲝𐲞𐲟𐲠𐲡𐲢𐲣𐲤𐲥𐲦𐲧𐲨𐲩𐲪𐲫𐲬𐲭𐲮𐲯𐲰𐲱𐲲𑢠𑢡𑢢𑢣𑢤𑢥𑢦𑢧𑢨𑢩𑢪𑢫𑢬𑢭𑢮𑢯𑢰𑢱𑢲𑢳𑢴𑢵𑢶𑢷𑢸𑢹𑢺𑢻𑢼𑢽𑢾𑢿𖹀𖹁𖹂𖹃𖹄𖹅𖹆𖹇𖹈𖹉𖹊𖹋𖹌𖹍𖹎𖹏𖹐𖹑𖹒𖹓𖹔𖹕𖹖𖹗𖹘𖹙𖹚𖹛𖹜𖹝𖹞𖹟𞤀𞤁𞤂𞤃𞤄𞤅𞤆𞤇𞤈𞤉𞤊𞤋𞤌𞤍𞤎𞤏𞤐𞤑𞤒𞤓𞤔𞤕𞤖𞤗𞤘𞤙𞤚𞤛𞤜𞤝𞤞𞤟𞤠𞤡ßİŉǰΐΰևẖẗẘẙẚẞὐὒὔὖᾀᾁᾂᾃᾄᾅᾆᾇᾈᾉᾊᾋᾌᾍᾎᾏᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝᾞᾟᾠᾡᾢᾣᾤᾥᾦᾧᾨᾩᾪᾫᾬᾭᾮᾯᾲᾳᾴᾶᾷᾼῂῃῄῆῇῌῒΐῖῗῢΰῤῦῧῲῳῴῶῷῼﬀﬁﬂﬃﬄﬅﬆﬓﬔﬕﬖﬗ]' THEN RETURN v_value;END IF;
 SELECT COALESCE(string_agg(CASE WHEN m.part[1] !~ '[µÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠƢƤƦƧƩƬƮƯƱƲƳƵƷƸƼǄǅǇǈǊǋǍǏǑǓǕǗǙǛǞǠǢǤǦǨǪǬǮǱǲǴǶǷǸǺǼǾȀȂȄȆȈȊȌȎȐȒȔȖȘȚȜȞȠȢȤȦȨȪȬȮȰȲȺȻȽȾɁɃɄɅɆɈɊɌɎͅͰͲͶͿΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫςϏϐϑϕϖϘϚϜϞϠϢϤϦϨϪϬϮϰϱϴϵϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯѠѢѤѦѨѪѬѮѰѲѴѶѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӃӅӇӉӋӍӐӒӔӖӘӚӜӞӠӢӤӦӨӪӬӮӰӲӴӶӸӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍᏸᏹᏺᏻᏼᏽᲀᲁᲂᲃᲄᲅᲆᲇᲈᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẛẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾἈἉἊἋἌἍἎἏἘἙἚἛἜἝἨἩἪἫἬἭἮἯἸἹἺἻἼἽἾἿὈὉὊὋὌὍὙὛὝὟὨὩὪὫὬὭὮὯᾸᾹᾺΆιῈΈῊΉῘῙῚΊῨῩῪΎῬῸΌῺΏΩKÅℲⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯↃⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟐꟖꟘꟵꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇𐐈𐐉𐐊𐐋𐐌𐐍𐐎𐐏𐐐𐐑𐐒𐐓𐐔𐐕𐐖𐐗𐐘𐐙𐐚𐐛𐐜𐐝𐐞𐐟𐐠𐐡𐐢𐐣𐐤𐐥𐐦𐐧𐒰𐒱𐒲𐒳𐒴𐒵𐒶𐒷𐒸𐒹𐒺𐒻𐒼𐒽𐒾𐒿𐓀𐓁𐓂𐓃𐓄𐓅𐓆𐓇𐓈𐓉𐓊𐓋𐓌𐓍𐓎𐓏𐓐𐓑𐓒𐓓𐕰𐕱𐕲𐕳𐕴𐕵𐕶𐕷𐕸𐕹𐕺𐕼𐕽𐕾𐕿𐖀𐖁𐖂𐖃𐖄𐖅𐖆𐖇𐖈𐖉𐖊𐖌𐖍𐖎𐖏𐖐𐖑𐖒𐖔𐖕𐲀𐲁𐲂𐲃𐲄𐲅𐲆𐲇𐲈𐲉𐲊𐲋𐲌𐲍𐲎𐲏𐲐𐲑𐲒𐲓𐲔𐲕𐲖𐲗𐲘𐲙𐲚𐲛𐲜𐲝𐲞𐲟𐲠𐲡𐲢𐲣𐲤𐲥𐲦𐲧𐲨𐲩𐲪𐲫𐲬𐲭𐲮𐲯𐲰𐲱𐲲𑢠𑢡𑢢𑢣𑢤𑢥𑢦𑢧𑢨𑢩𑢪𑢫𑢬𑢭𑢮𑢯𑢰𑢱𑢲𑢳𑢴𑢵𑢶𑢷𑢸𑢹𑢺𑢻𑢼𑢽𑢾𑢿𖹀𖹁𖹂𖹃𖹄𖹅𖹆𖹇𖹈𖹉𖹊𖹋𖹌𖹍𖹎𖹏𖹐𖹑𖹒𖹓𖹔𖹕𖹖𖹗𖹘𖹙𖹚𖹛𖹜𖹝𖹞𖹟𞤀𞤁𞤂𞤃𞤄𞤅𞤆𞤇𞤈𞤉𞤊𞤋𞤌𞤍𞤎𞤏𞤐𞤑𞤒𞤓𞤔𞤕𞤖𞤗𞤘𞤙𞤚𞤛𞤜𞤝𞤞𞤟𞤠𞤡ßİŉǰΐΰևẖẗẘẙẚẞὐὒὔὖᾀᾁᾂᾃᾄᾅᾆᾇᾈᾉᾊᾋᾌᾍᾎᾏᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝᾞᾟᾠᾡᾢᾣᾤᾥᾦᾧᾨᾩᾪᾫᾬᾭᾮᾯᾲᾳᾴᾶᾷᾼῂῃῄῆῇῌῒΐῖῗῢΰῤῦῧῲῳῴῶῷῼﬀﬁﬂﬃﬄﬅﬆﬓﬔﬕﬖﬗ]' THEN m.part[1]
  ELSE COALESCE(v_multi->>m.part[1],translate(m.part[1],v_from,v_to)) END,'' ORDER BY m.ordinal),'') INTO v_folded
 FROM regexp_matches(v_value,'([^µÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠƢƤƦƧƩƬƮƯƱƲƳƵƷƸƼǄǅǇǈǊǋǍǏǑǓǕǗǙǛǞǠǢǤǦǨǪǬǮǱǲǴǶǷǸǺǼǾȀȂȄȆȈȊȌȎȐȒȔȖȘȚȜȞȠȢȤȦȨȪȬȮȰȲȺȻȽȾɁɃɄɅɆɈɊɌɎͅͰͲͶͿΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫςϏϐϑϕϖϘϚϜϞϠϢϤϦϨϪϬϮϰϱϴϵϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯѠѢѤѦѨѪѬѮѰѲѴѶѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӃӅӇӉӋӍӐӒӔӖӘӚӜӞӠӢӤӦӨӪӬӮӰӲӴӶӸӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍᏸᏹᏺᏻᏼᏽᲀᲁᲂᲃᲄᲅᲆᲇᲈᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẛẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾἈἉἊἋἌἍἎἏἘἙἚἛἜἝἨἩἪἫἬἭἮἯἸἹἺἻἼἽἾἿὈὉὊὋὌὍὙὛὝὟὨὩὪὫὬὭὮὯᾸᾹᾺΆιῈΈῊΉῘῙῚΊῨῩῪΎῬῸΌῺΏΩKÅℲⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯↃⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟐꟖꟘꟵꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇𐐈𐐉𐐊𐐋𐐌𐐍𐐎𐐏𐐐𐐑𐐒𐐓𐐔𐐕𐐖𐐗𐐘𐐙𐐚𐐛𐐜𐐝𐐞𐐟𐐠𐐡𐐢𐐣𐐤𐐥𐐦𐐧𐒰𐒱𐒲𐒳𐒴𐒵𐒶𐒷𐒸𐒹𐒺𐒻𐒼𐒽𐒾𐒿𐓀𐓁𐓂𐓃𐓄𐓅𐓆𐓇𐓈𐓉𐓊𐓋𐓌𐓍𐓎𐓏𐓐𐓑𐓒𐓓𐕰𐕱𐕲𐕳𐕴𐕵𐕶𐕷𐕸𐕹𐕺𐕼𐕽𐕾𐕿𐖀𐖁𐖂𐖃𐖄𐖅𐖆𐖇𐖈𐖉𐖊𐖌𐖍𐖎𐖏𐖐𐖑𐖒𐖔𐖕𐲀𐲁𐲂𐲃𐲄𐲅𐲆𐲇𐲈𐲉𐲊𐲋𐲌𐲍𐲎𐲏𐲐𐲑𐲒𐲓𐲔𐲕𐲖𐲗𐲘𐲙𐲚𐲛𐲜𐲝𐲞𐲟𐲠𐲡𐲢𐲣𐲤𐲥𐲦𐲧𐲨𐲩𐲪𐲫𐲬𐲭𐲮𐲯𐲰𐲱𐲲𑢠𑢡𑢢𑢣𑢤𑢥𑢦𑢧𑢨𑢩𑢪𑢫𑢬𑢭𑢮𑢯𑢰𑢱𑢲𑢳𑢴𑢵𑢶𑢷𑢸𑢹𑢺𑢻𑢼𑢽𑢾𑢿𖹀𖹁𖹂𖹃𖹄𖹅𖹆𖹇𖹈𖹉𖹊𖹋𖹌𖹍𖹎𖹏𖹐𖹑𖹒𖹓𖹔𖹕𖹖𖹗𖹘𖹙𖹚𖹛𖹜𖹝𖹞𖹟𞤀𞤁𞤂𞤃𞤄𞤅𞤆𞤇𞤈𞤉𞤊𞤋𞤌𞤍𞤎𞤏𞤐𞤑𞤒𞤓𞤔𞤕𞤖𞤗𞤘𞤙𞤚𞤛𞤜𞤝𞤞𞤟𞤠𞤡ßİŉǰΐΰևẖẗẘẙẚẞὐὒὔὖᾀᾁᾂᾃᾄᾅᾆᾇᾈᾉᾊᾋᾌᾍᾎᾏᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝᾞᾟᾠᾡᾢᾣᾤᾥᾦᾧᾨᾩᾪᾫᾬᾭᾮᾯᾲᾳᾴᾶᾷᾼῂῃῄῆῇῌῒΐῖῗῢΰῤῦῧῲῳῴῶῷῼﬀﬁﬂﬃﬄﬅﬆﬓﬔﬕﬖﬗ]+|[µÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠƢƤƦƧƩƬƮƯƱƲƳƵƷƸƼǄǅǇǈǊǋǍǏǑǓǕǗǙǛǞǠǢǤǦǨǪǬǮǱǲǴǶǷǸǺǼǾȀȂȄȆȈȊȌȎȐȒȔȖȘȚȜȞȠȢȤȦȨȪȬȮȰȲȺȻȽȾɁɃɄɅɆɈɊɌɎͅͰͲͶͿΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫςϏϐϑϕϖϘϚϜϞϠϢϤϦϨϪϬϮϰϱϴϵϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯѠѢѤѦѨѪѬѮѰѲѴѶѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӃӅӇӉӋӍӐӒӔӖӘӚӜӞӠӢӤӦӨӪӬӮӰӲӴӶӸӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍᏸᏹᏺᏻᏼᏽᲀᲁᲂᲃᲄᲅᲆᲇᲈᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẛẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾἈἉἊἋἌἍἎἏἘἙἚἛἜἝἨἩἪἫἬἭἮἯἸἹἺἻἼἽἾἿὈὉὊὋὌὍὙὛὝὟὨὩὪὫὬὭὮὯᾸᾹᾺΆιῈΈῊΉῘῙῚΊῨῩῪΎῬῸΌῺΏΩKÅℲⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯↃⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟐꟖꟘꟵꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇𐐈𐐉𐐊𐐋𐐌𐐍𐐎𐐏𐐐𐐑𐐒𐐓𐐔𐐕𐐖𐐗𐐘𐐙𐐚𐐛𐐜𐐝𐐞𐐟𐐠𐐡𐐢𐐣𐐤𐐥𐐦𐐧𐒰𐒱𐒲𐒳𐒴𐒵𐒶𐒷𐒸𐒹𐒺𐒻𐒼𐒽𐒾𐒿𐓀𐓁𐓂𐓃𐓄𐓅𐓆𐓇𐓈𐓉𐓊𐓋𐓌𐓍𐓎𐓏𐓐𐓑𐓒𐓓𐕰𐕱𐕲𐕳𐕴𐕵𐕶𐕷𐕸𐕹𐕺𐕼𐕽𐕾𐕿𐖀𐖁𐖂𐖃𐖄𐖅𐖆𐖇𐖈𐖉𐖊𐖌𐖍𐖎𐖏𐖐𐖑𐖒𐖔𐖕𐲀𐲁𐲂𐲃𐲄𐲅𐲆𐲇𐲈𐲉𐲊𐲋𐲌𐲍𐲎𐲏𐲐𐲑𐲒𐲓𐲔𐲕𐲖𐲗𐲘𐲙𐲚𐲛𐲜𐲝𐲞𐲟𐲠𐲡𐲢𐲣𐲤𐲥𐲦𐲧𐲨𐲩𐲪𐲫𐲬𐲭𐲮𐲯𐲰𐲱𐲲𑢠𑢡𑢢𑢣𑢤𑢥𑢦𑢧𑢨𑢩𑢪𑢫𑢬𑢭𑢮𑢯𑢰𑢱𑢲𑢳𑢴𑢵𑢶𑢷𑢸𑢹𑢺𑢻𑢼𑢽𑢾𑢿𖹀𖹁𖹂𖹃𖹄𖹅𖹆𖹇𖹈𖹉𖹊𖹋𖹌𖹍𖹎𖹏𖹐𖹑𖹒𖹓𖹔𖹕𖹖𖹗𖹘𖹙𖹚𖹛𖹜𖹝𖹞𖹟𞤀𞤁𞤂𞤃𞤄𞤅𞤆𞤇𞤈𞤉𞤊𞤋𞤌𞤍𞤎𞤏𞤐𞤑𞤒𞤓𞤔𞤕𞤖𞤗𞤘𞤙𞤚𞤛𞤜𞤝𞤞𞤟𞤠𞤡]+|[ßİŉǰΐΰևẖẗẘẙẚẞὐὒὔὖᾀᾁᾂᾃᾄᾅᾆᾇᾈᾉᾊᾋᾌᾍᾎᾏᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝᾞᾟᾠᾡᾢᾣᾤᾥᾦᾧᾨᾩᾪᾫᾬᾭᾮᾯᾲᾳᾴᾶᾷᾼῂῃῄῆῇῌῒΐῖῗῢΰῤῦῧῲῳῴῶῷῼﬀﬁﬂﬃﬄﬅﬆﬓﬔﬕﬖﬗ])','g') WITH ORDINALITY m(part,ordinal);
 RETURN v_folded;
END $f$;
CREATE FUNCTION fountain_private.content_fold(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
 SELECT btrim(regexp_replace(fountain_private.content_casefold(normalize(p_value,NFKC)),E'[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+',' ','g'),' ')
$f$;
CREATE FUNCTION fountain_private.content_lock(p_workspace_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||p_workspace_id,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN
  RAISE EXCEPTION 'CONTENT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
END $f$;
CREATE FUNCTION fountain_private.content_touch(p_workspace_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 PERFORM fountain_private.content_lock(p_workspace_id);
 INSERT INTO fountain_private.content_search_state AS s(workspace_id,index_version,content_revision,ready) VALUES(p_workspace_id,1,1,true)
 ON CONFLICT(workspace_id) DO UPDATE SET content_revision=s.content_revision+1
 WHERE s.index_version=1 AND s.content_revision<9007199254740991;
 IF NOT FOUND THEN RAISE EXCEPTION 'Content revision limit exceeded' USING ERRCODE='PT413';END IF;
END $f$;
CREATE FUNCTION fountain_private.content_header(p_kind text,p_data jsonb,p_database jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE v_header jsonb;v_values jsonb;v_field text;
BEGIN
 SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) INTO v_header
 FROM jsonb_each(CASE WHEN jsonb_typeof(p_data)='object' THEN p_data ELSE '{}'::jsonb END) f
 WHERE f.key=ANY(ARRAY['id','owner_id','parent_id','teamspace_id','permissions','archived','deleted','deleted_at','locked','revision']);
 IF p_kind='database' THEN
  IF p_data ? 'row_permissions' THEN v_header:=v_header||jsonb_build_object('row_permissions',p_data->'row_permissions');END IF;
  v_header:=v_header||jsonb_build_object('properties',CASE WHEN jsonb_typeof(p_data->'properties')='array' THEN
   (SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(p.value)='object' THEN
    (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(p.value) f WHERE f.key IN('id','type')) ELSE 'null'::jsonb END ORDER BY p.ordinal),'[]'::jsonb)
   FROM jsonb_array_elements(p_data->'properties') WITH ORDINALITY p(value,ordinal)) ELSE 'null'::jsonb END);
 ELSIF p_kind='row' THEN
  IF p_data ? 'database_id' THEN v_header:=v_header||jsonb_build_object('database_id',p_data->'database_id');END IF;
  v_field:=p_database->'row_permissions'->>'property_id';
  v_values:=CASE WHEN jsonb_typeof(p_data->'properties')='object' THEN p_data->'properties'->v_field END;
  v_header:=v_header||jsonb_build_object('assignment_values',CASE WHEN jsonb_typeof(v_values)='string' THEN jsonb_build_array(v_values)
   WHEN jsonb_typeof(v_values)='array' THEN (SELECT COALESCE(jsonb_agg(v.value ORDER BY v.ordinal),'[]'::jsonb) FROM jsonb_array_elements(v_values) WITH ORDINALITY v(value,ordinal) WHERE jsonb_typeof(v.value)='string') ELSE '[]'::jsonb END);
 END IF;
 RETURN v_header;
END $f$;
CREATE FUNCTION fountain_private.content_truth(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $f$
 SELECT p_value IS NOT NULL AND p_value NOT IN('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb)
$f$;
CREATE FUNCTION fountain_private.content_date_atom(p_value text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
DECLARE m text[];v_stamp timestamp;v_offset integer;
BEGIN
 IF p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
  v_stamp:=make_date(substring(p_value,1,4)::integer,substring(p_value,6,2)::integer,substring(p_value,9,2)::integer)::timestamp;
  RETURN jsonb_build_object('kind','day','time',extract(epoch FROM v_stamp));
 END IF;
 m:=regexp_match(p_value,'^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$');
 IF m IS NULL OR m[1]::integer<1 OR m[4]::integer>23 OR m[5]::integer>59 OR m[6]::integer>59 OR COALESCE(m[10],'0')::integer>23 OR COALESCE(m[11],'0')::integer>59 THEN RETURN NULL;END IF;
 v_stamp:=make_timestamp(m[1]::integer,m[2]::integer,m[3]::integer,m[4]::integer,m[5]::integer,m[6]::double precision)
  +COALESCE(('0.'||m[7])::numeric,0)*interval '1 second';
 v_offset:=(COALESCE(m[10],'0')::integer*60+COALESCE(m[11],'0')::integer)*CASE WHEN m[9]='-' THEN -1 ELSE 1 END;
 v_stamp:=v_stamp-v_offset*interval '1 minute';
 IF v_stamp<timestamp '0001-01-01' OR v_stamp>=timestamp '10000-01-01' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('kind','time','time',floor(extract(epoch FROM v_stamp)*1000)/1000);
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN RETURN NULL;
END $f$;
CREATE FUNCTION fountain_private.content_scalar(p_kind text,p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET extra_float_digits=3 AS $f$
DECLARE v_number double precision;v_number_text text;v_start jsonb;v_end jsonb;v_text text;
BEGIN
 IF p_kind IN('title','text','select','status','url','email','phone') AND jsonb_typeof(p_value)='string' THEN RETURN p_value#>>'{}';
 ELSIF p_kind='checkbox' AND jsonb_typeof(p_value)='boolean' THEN RETURN p_value#>>'{}';
 ELSIF p_kind='multi_select' AND jsonb_typeof(p_value)='array' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_value) x WHERE jsonb_typeof(x.value)<>'string') THEN RETURN '';END IF;
  SELECT COALESCE(string_agg(x.value#>>'{}',' ' ORDER BY x.ordinal),'') INTO v_text FROM jsonb_array_elements(p_value) WITH ORDINALITY x(value,ordinal);RETURN v_text;
 ELSIF p_kind='number' AND jsonb_typeof(p_value)='number' THEN
  v_number:=(p_value#>>'{}')::double precision;
  IF v_number=0 THEN RETURN '0';END IF;
  IF trunc(v_number)=v_number AND abs(v_number)>9007199254740991 THEN RETURN '';END IF;
  v_number_text:=v_number::text;
  IF abs(v_number)>=0.000001 AND abs(v_number)<1e21 THEN RETURN trim_scale(v_number_text::numeric)::text;END IF;
  RETURN regexp_replace(v_number_text,'e\+?(-?)0*([0-9]+)$','e\1\2');
 ELSIF p_kind='date' THEN
  IF jsonb_typeof(p_value)='string' THEN
   v_text:=p_value#>>'{}';IF fountain_private.content_date_atom(v_text) IS NOT NULL THEN RETURN v_text;END IF;
  ELSIF jsonb_typeof(p_value)='object' AND p_value ?& ARRAY['start','end'] AND p_value-ARRAY['start','end']='{}'::jsonb AND jsonb_typeof(p_value->'start')='string' AND jsonb_typeof(p_value->'end')='string' THEN
   v_start:=fountain_private.content_date_atom(p_value->>'start');v_end:=fountain_private.content_date_atom(p_value->>'end');
   IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_start->>'kind'=v_end->>'kind' AND(v_start->>'time')::numeric<=(v_end->>'time')::numeric THEN RETURN(p_value->>'start')||' '||(p_value->>'end');END IF;
  END IF;
 END IF;
 -- Owner and Verification are computed metadata, deliberately absent in v1.
 RETURN '';
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN '';
END $f$;
CREATE FUNCTION fountain_private.content_pieces(p_kind text,p_data jsonb,p_database jsonb DEFAULT NULL) RETURNS SETOF text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
BEGIN
 IF p_kind='page' THEN
  RETURN QUERY SELECT b.value->>'text'
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'blocks')='array' THEN p_data->'blocks' ELSE '[]'::jsonb END) WITH ORDINALITY b(value,ordinal)
  WHERE jsonb_typeof(b.value)='object' AND CASE WHEN b.value ? 'type' THEN b.value->>'type' ELSE 'paragraph' END IN('paragraph','heading1','heading2','heading3','bullet','numbered','todo','quote','code','callout','toggle')
   AND NOT fountain_private.content_truth(b.value->'attachment_id') AND jsonb_typeof(b.value->'text')='string' ORDER BY b.ordinal;
 ELSIF p_kind='database' THEN
  IF jsonb_typeof(p_data->'description')='string' THEN RETURN NEXT p_data->>'description';END IF;
 ELSIF p_kind='row' THEN
  RETURN QUERY SELECT v.extracted FROM(SELECT p.ordinal,fountain_private.content_scalar(p.value->>'type',CASE WHEN jsonb_typeof(p_data->'properties')='object' THEN p_data->'properties'->(p.value->>'id') END) AS extracted
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_database->'properties')='array' THEN p_database->'properties' ELSE '[]'::jsonb END) WITH ORDINALITY p(value,ordinal)
   WHERE jsonb_typeof(p.value)='object' AND jsonb_typeof(p.value->'id')='string') v WHERE v.extracted<>'' ORDER BY v.ordinal;
 END IF;
END $f$;
CREATE FUNCTION fountain_private.content_refresh(p_workspace_id text,p_kind text,p_id text,p_created boolean DEFAULT false,p_reproject boolean DEFAULT false,p_reindex boolean DEFAULT true,p_editor_changed boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
#variable_conflict error
DECLARE v_source fountain_private.entities;v_database jsonb;v_previous fountain_private.content_search_documents;
 v_title text:='';v_body text;v_header jsonb;v_hash text;v_generation text;v_valid boolean:=true;v_error text;
 v_piece text;v_buffer text:='';v_started boolean:=false;v_at integer;v_take integer;v_ordinal integer:=0;v_length bigint:=0;
 v_actor jsonb;v_actor_id text;v_cause text:='unknown';v_property text;v_content_changed boolean;v_header_changed boolean;v_editor_changed boolean;
BEGIN
 IF p_kind NOT IN('page','database','row') THEN RAISE EXCEPTION 'Invalid content kind' USING ERRCODE='22023';END IF;
 PERFORM fountain_private.content_lock(p_workspace_id);
 SELECT e.* INTO v_source FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind=p_kind AND e.id=p_id;
 IF NOT FOUND THEN
  DELETE FROM fountain_private.content_search_documents d WHERE d.workspace_id=p_workspace_id AND d.kind=p_kind AND d.id=p_id;
  PERFORM fountain_private.content_touch(p_workspace_id);RETURN;
 END IF;
 SELECT d.* INTO v_previous FROM fountain_private.content_search_documents d WHERE d.workspace_id=p_workspace_id AND d.kind=p_kind AND d.id=p_id;
 v_generation:=COALESCE(v_previous.generation,replace(gen_random_uuid()::text,'-',''));
 IF jsonb_typeof(v_source.data) IS DISTINCT FROM 'object' OR v_source.data->'id' IS DISTINCT FROM to_jsonb(p_id) THEN v_valid:=false;v_error:='malformed_entity';END IF;
 IF p_kind='page' THEN
  v_title:=CASE WHEN jsonb_typeof(v_source.data->'title')='string' THEN v_source.data->>'title' ELSE '' END;
  IF v_source.data ? 'blocks' AND jsonb_typeof(v_source.data->'blocks') IS DISTINCT FROM 'array' THEN v_valid:=false;v_error:='malformed_blocks';END IF;
 ELSIF p_kind='database' THEN
  v_title:=CASE WHEN jsonb_typeof(v_source.data->'name')='string' THEN v_source.data->>'name' WHEN jsonb_typeof(v_source.data->'title')='string' THEN v_source.data->>'title' ELSE '' END;
 ELSE
  IF jsonb_typeof(v_source.data->'database_id')='string' THEN SELECT e.data INTO v_database FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='database' AND e.id=v_source.data->>'database_id';END IF;
  IF v_database IS NULL THEN v_valid:=false;v_error:='missing_database';END IF;
  IF jsonb_typeof(v_source.data->'properties') IS DISTINCT FROM 'object' THEN v_valid:=false;v_error:='malformed_row_values';END IF;
  SELECT p.value->>'id' INTO v_property FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_database->'properties')='array' THEN v_database->'properties' ELSE '[]'::jsonb END) WITH ORDINALITY p(value,ordinal) WHERE p.value->>'type'='title' ORDER BY p.ordinal LIMIT 1;
  v_title:=CASE WHEN jsonb_typeof(v_source.data->'properties'->v_property)='string' THEN v_source.data->'properties'->>v_property ELSE '' END;
 END IF;
 IF p_kind IN('database','row') THEN
  IF jsonb_typeof(CASE WHEN p_kind='database' THEN v_source.data->'properties' ELSE v_database->'properties' END) IS DISTINCT FROM 'array' THEN v_valid:=false;v_error:='malformed_schema';
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN p_kind='database' THEN v_source.data->'properties' ELSE v_database->'properties' END) p WHERE jsonb_typeof(p)<>'object' OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR length(p->>'id') NOT BETWEEN 1 AND 160 OR jsonb_typeof(p->'type') IS DISTINCT FROM 'string')
   OR(SELECT count(*)<>count(DISTINCT p->>'id') FROM jsonb_array_elements(CASE WHEN p_kind='database' THEN v_source.data->'properties' ELSE v_database->'properties' END) p) THEN v_valid:=false;v_error:='malformed_schema';END IF;
 END IF;
 v_header:=fountain_private.content_header(p_kind,v_source.data,v_database);
 -- Normalize one authored piece at a time. A literal ASCII separator between
 -- pieces is a Unicode normalization boundary. Keep only an 8192-character
 -- rolling buffer plus the current source piece; never join a whole document.
 IF v_previous.generation IS NULL OR p_reindex THEN
  v_hash:=encode(sha256(convert_to(jsonb_build_array(v_title)::text,'UTF8')),'hex');
 ELSE v_hash:=v_previous.text_revision;END IF;
 v_content_changed:=v_previous.text_revision IS DISTINCT FROM v_hash;
 v_header_changed:=v_previous.header IS DISTINCT FROM v_header;
 BEGIN v_actor:=NULLIF(current_setting('fountain.content_actor',true),'')::jsonb;EXCEPTION WHEN invalid_text_representation THEN v_actor:=NULL;END;
 IF v_actor->>'workspace_id'=p_workspace_id AND v_actor->>'cause' IN('human','automation','import','public_form','system','scim') AND jsonb_typeof(v_actor->'member_id')='string' AND length(v_actor->>'member_id') BETWEEN 1 AND 160 THEN v_actor_id:=v_actor->>'member_id';v_cause:=CASE WHEN v_actor->>'cause'='scim' THEN 'system' ELSE v_actor->>'cause' END;END IF;
 INSERT INTO fountain_private.content_search_documents(workspace_id,kind,id,generation,title,title_fold,id_fold,icon,header,created_at,updated_at,text_revision,validity,error)
 VALUES(p_workspace_id,p_kind,p_id,v_generation,v_title,fountain_private.content_fold(v_title),fountain_private.content_fold(p_id),CASE WHEN jsonb_typeof(v_source.data->'icon')='string' THEN v_source.data->>'icon' END,v_header,v_source.created_at,v_source.updated_at,v_hash,v_valid,v_error)
 ON CONFLICT(workspace_id,kind,id) DO UPDATE SET title=EXCLUDED.title,title_fold=EXCLUDED.title_fold,id_fold=EXCLUDED.id_fold,icon=EXCLUDED.icon,header=EXCLUDED.header,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,text_revision=EXCLUDED.text_revision,validity=EXCLUDED.validity,error=EXCLUDED.error;
 IF v_previous.generation IS NULL OR p_reindex THEN
  DELETE FROM fountain_private.content_search_chunks c WHERE c.workspace_id=p_workspace_id AND c.kind=p_kind AND c.id=p_id;
  FOR v_piece IN SELECT fountain_private.content_display(p.value) FROM fountain_private.content_pieces(p_kind,v_source.data,v_database) p(value) LOOP
   IF v_piece='' THEN CONTINUE;END IF;
   IF v_started THEN v_buffer:=v_buffer||' ';v_length:=v_length+1;END IF;
   v_started:=true;v_length:=v_length+length(v_piece);v_at:=1;
   WHILE v_at<=length(v_piece) LOOP
    v_take:=LEAST(8192-length(v_buffer),length(v_piece)-v_at+1);
    v_buffer:=v_buffer||substring(v_piece,v_at,v_take);v_at:=v_at+v_take;
    WHILE length(v_buffer)>=4096 LOOP
     v_body:=substring(v_buffer,1,4096);
     INSERT INTO fountain_private.content_search_chunks VALUES(p_workspace_id,p_kind,p_id,v_ordinal,v_body,fountain_private.content_casefold(v_body));
     v_hash:=encode(sha256(convert_to(v_hash||v_body,'UTF8')),'hex');v_ordinal:=v_ordinal+1;
     v_buffer:=substring(v_buffer,3585);
    END LOOP;
   END LOOP;
  END LOOP;
  IF v_buffer<>'' THEN
   INSERT INTO fountain_private.content_search_chunks VALUES(p_workspace_id,p_kind,p_id,v_ordinal,v_buffer,fountain_private.content_casefold(v_buffer));
   v_hash:=encode(sha256(convert_to(v_hash||v_buffer,'UTF8')),'hex');
  END IF;
  v_hash:=encode(sha256(convert_to(v_hash||':'||v_length::text,'UTF8')),'hex');
  UPDATE fountain_private.content_search_documents SET text_revision=v_hash WHERE workspace_id=p_workspace_id AND kind=p_kind AND id=p_id;
 END IF;
 v_content_changed:=v_previous.text_revision IS DISTINCT FROM v_hash;
 v_editor_changed:=p_editor_changed OR(v_content_changed AND NOT p_reproject);

 INSERT INTO fountain_private.content_provenance(workspace_id,kind,id,generation,creator_id,creator_cause,editor_id,edited_at,editor_cause,manager_id,manager_at)
 VALUES(p_workspace_id,p_kind,p_id,v_generation,CASE WHEN p_created THEN v_actor_id END,CASE WHEN p_created THEN v_cause ELSE 'unknown' END,
  CASE WHEN p_created THEN v_actor_id END,CASE WHEN p_created AND v_actor_id IS NOT NULL THEN v_source.updated_at END,CASE WHEN p_created THEN v_cause ELSE 'unknown' END,NULL,NULL)
 ON CONFLICT(workspace_id,kind,id) DO UPDATE SET
 editor_id=CASE WHEN v_editor_changed THEN v_actor_id ELSE content_provenance.editor_id END,
 edited_at=CASE WHEN v_editor_changed THEN CASE WHEN v_actor_id IS NOT NULL THEN v_source.updated_at END ELSE content_provenance.edited_at END,
 editor_cause=CASE WHEN v_editor_changed THEN v_cause ELSE content_provenance.editor_cause END,
 manager_id=CASE WHEN(v_header_changed AND NOT v_editor_changed) OR(p_reproject AND v_content_changed) THEN v_actor_id ELSE content_provenance.manager_id END,
 manager_at=CASE WHEN(v_header_changed AND NOT v_editor_changed) OR(p_reproject AND v_content_changed) THEN CASE WHEN v_actor_id IS NOT NULL THEN to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00' END ELSE content_provenance.manager_at END;
 PERFORM fountain_private.content_touch(p_workspace_id);
END $f$;
CREATE FUNCTION fountain_private.content_manage_target(p_workspace_id text,p_kind text,p_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_actor jsonb;v_actor_id text;
BEGIN
 IF p_kind NOT IN('page','database') OR p_id IS NULL THEN RETURN;END IF;
 PERFORM fountain_private.content_lock(p_workspace_id);
 BEGIN v_actor:=NULLIF(current_setting('fountain.content_actor',true),'')::jsonb;EXCEPTION WHEN invalid_text_representation THEN v_actor:=NULL;END;
 IF v_actor->>'workspace_id'=p_workspace_id AND v_actor->>'cause' IN('human','automation','import','public_form','system','scim')
  AND jsonb_typeof(v_actor->'member_id')='string' AND length(v_actor->>'member_id') BETWEEN 1 AND 160 THEN v_actor_id:=v_actor->>'member_id';END IF;
 UPDATE fountain_private.content_provenance SET manager_id=v_actor_id,
 manager_at=CASE WHEN v_actor_id IS NOT NULL THEN to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00' END
 WHERE workspace_id=p_workspace_id AND kind=p_kind AND id=p_id;
END $f$;
CREATE FUNCTION fountain_private.content_entity_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_ws text;v_kind text;v_id text;v_row record;v_reindex boolean:=true;v_editor_changed boolean:=false;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'entities' THEN RAISE EXCEPTION 'Invalid content entity trigger' USING ERRCODE='22023';END IF;
 IF TG_OP='DELETE' THEN v_ws:=OLD.workspace_id;v_kind:=OLD.kind;v_id:=OLD.id;ELSE v_ws:=NEW.workspace_id;v_kind:=NEW.kind;v_id:=NEW.id;END IF;
 -- Publication configuration is management of its target resource, never
 -- content editing. Attribute both ends when a site/form target is moved.
 IF TG_OP IN('UPDATE','DELETE') AND OLD.kind IN('site','form') THEN
  IF TG_OP='DELETE' OR NEW.workspace_id<>OLD.workspace_id OR NEW.kind<>OLD.kind
   OR(CASE WHEN OLD.kind='site' THEN OLD.data->'page_id' ELSE OLD.data->'database_id' END) IS DISTINCT FROM(CASE WHEN NEW.kind='site' THEN NEW.data->'page_id' ELSE NEW.data->'database_id' END) THEN
   PERFORM fountain_private.content_manage_target(OLD.workspace_id,CASE WHEN OLD.kind='site' THEN 'page' ELSE 'database' END,CASE WHEN OLD.kind='site' THEN OLD.data->>'page_id' ELSE OLD.data->>'database_id' END);
  END IF;
 END IF;
 IF TG_OP IN('INSERT','UPDATE') AND NEW.kind IN('site','form') THEN
  PERFORM fountain_private.content_manage_target(NEW.workspace_id,CASE WHEN NEW.kind='site' THEN 'page' ELSE 'database' END,CASE WHEN NEW.kind='site' THEN NEW.data->>'page_id' ELSE NEW.data->>'database_id' END);
 END IF;
 IF TG_OP='UPDATE' AND(NEW.workspace_id<>OLD.workspace_id OR NEW.kind<>OLD.kind OR NEW.id<>OLD.id) THEN
  IF OLD.kind IN('page','database','row') THEN
   PERFORM fountain_private.content_refresh(OLD.workspace_id,OLD.kind,OLD.id,false);
   IF OLD.kind='database' THEN
    FOR v_row IN SELECT e.id FROM fountain_private.entities e WHERE e.workspace_id=OLD.workspace_id AND e.kind='row' AND e.data->>'database_id'=OLD.id ORDER BY e.id COLLATE "C" LOOP
     PERFORM fountain_private.content_refresh(OLD.workspace_id,'row',v_row.id,false,true);
    END LOOP;
   END IF;
  ELSIF OLD.kind IN('member','group','teamspace','site','form','settings') THEN PERFORM fountain_private.content_touch(OLD.workspace_id);END IF;
 END IF;
 IF v_kind IN('page','database','row') THEN
  IF TG_OP='UPDATE' THEN
   IF v_kind='page' THEN v_reindex:=OLD.data->'title' IS DISTINCT FROM NEW.data->'title' OR OLD.data->'blocks' IS DISTINCT FROM NEW.data->'blocks';
   ELSIF v_kind='database' THEN v_reindex:=OLD.data->'name' IS DISTINCT FROM NEW.data->'name' OR OLD.data->'title' IS DISTINCT FROM NEW.data->'title' OR OLD.data->'description' IS DISTINCT FROM NEW.data->'description';
   ELSE v_reindex:=OLD.data->'properties' IS DISTINCT FROM NEW.data->'properties' OR OLD.data->'database_id' IS DISTINCT FROM NEW.data->'database_id';END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
   v_editor_changed:=v_reindex OR OLD.data->'icon' IS DISTINCT FROM NEW.data->'icon'
    OR OLD.data->'parent_id' IS DISTINCT FROM NEW.data->'parent_id' OR OLD.data->'teamspace_id' IS DISTINCT FROM NEW.data->'teamspace_id'
    OR(v_kind='database' AND OLD.data->'properties' IS DISTINCT FROM NEW.data->'properties');
  END IF;
  PERFORM fountain_private.content_refresh(v_ws,v_kind,v_id,TG_OP='INSERT',false,v_reindex,v_editor_changed);
  IF v_kind='database' AND(TG_OP<>'UPDATE' OR OLD.data->'properties' IS DISTINCT FROM NEW.data->'properties' OR OLD.data->'row_permissions' IS DISTINCT FROM NEW.data->'row_permissions') THEN
   FOR v_row IN SELECT e.id FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='row' AND e.data->>'database_id'=v_id ORDER BY e.id COLLATE "C" LOOP
    PERFORM fountain_private.content_refresh(v_ws,'row',v_row.id,false,true);
   END LOOP;
  END IF;
 ELSIF v_kind IN('member','group','teamspace','site','form','settings') THEN PERFORM fountain_private.content_touch(v_ws);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $f$;
CREATE FUNCTION fountain_private.content_provenance_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'content_provenance' THEN RAISE EXCEPTION 'Invalid content provenance trigger' USING ERRCODE='22023';END IF;
 IF TG_OP='DELETE' THEN PERFORM fountain_private.content_touch(OLD.workspace_id);RETURN OLD;END IF;
 PERFORM fountain_private.content_touch(NEW.workspace_id);RETURN NEW;
END $f$;
CREATE FUNCTION fountain_private.content_access_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'meta' THEN RAISE EXCEPTION 'Invalid content access trigger' USING ERRCODE='22023';END IF;
 IF TG_OP='DELETE' THEN PERFORM fountain_private.content_touch(OLD.workspace_id);RETURN OLD;END IF;
 IF TG_OP='INSERT' OR NEW.data IS DISTINCT FROM OLD.data THEN PERFORM fountain_private.content_touch(NEW.workspace_id);END IF;
 RETURN NEW;
END $f$;

-- Existing resources have no verifiable historical creator/editor. Build only
-- derivative tables; no source timestamp, entity, ACL or revision is touched.
DO $backfill$
DECLARE w record;e record;
BEGIN
 FOR w IN SELECT DISTINCT workspace_id COLLATE "C" AS workspace_id FROM fountain_private.entities ORDER BY workspace_id LOOP
  PERFORM fountain_private.content_lock(w.workspace_id);
  INSERT INTO fountain_private.content_search_state(workspace_id,index_version,content_revision,ready) VALUES(w.workspace_id,1,0,false);
  FOR e IN SELECT kind,id FROM fountain_private.entities WHERE workspace_id=w.workspace_id AND kind IN('page','database','row') ORDER BY kind COLLATE "C",id COLLATE "C" LOOP
   PERFORM fountain_private.content_refresh(w.workspace_id,e.kind,e.id,false);
  END LOOP;
  UPDATE fountain_private.content_search_state SET ready=true WHERE workspace_id=w.workspace_id;
 END LOOP;
END $backfill$;
CREATE TRIGGER fountain_content_entity AFTER INSERT OR UPDATE OR DELETE ON fountain_private.entities
 FOR EACH ROW EXECUTE FUNCTION fountain_private.content_entity_event();
CREATE TRIGGER fountain_content_provenance AFTER INSERT OR UPDATE OR DELETE ON fountain_private.content_provenance
 FOR EACH ROW EXECUTE FUNCTION fountain_private.content_provenance_event();
CREATE TRIGGER fountain_content_access_insert AFTER INSERT ON fountain_private.meta
 FOR EACH ROW WHEN(NEW.key='access_revision') EXECUTE FUNCTION fountain_private.content_access_event();
CREATE TRIGGER fountain_content_access_update AFTER UPDATE ON fountain_private.meta
 FOR EACH ROW WHEN(NEW.key='access_revision') EXECUTE FUNCTION fountain_private.content_access_event();
CREATE TRIGGER fountain_content_access_delete AFTER DELETE ON fountain_private.meta
 FOR EACH ROW WHEN(OLD.key='access_revision') EXECUTE FUNCTION fountain_private.content_access_event();
-- Optional outer origin is server-authored provenance, never document data or authorization.
CREATE OR REPLACE FUNCTION fountain_cloud.store_apply_changes_locked(p_workspace_id text,p_expected_revision bigint,p_changes jsonb) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text:=p_workspace_id;v_revision bigint;v_change jsonb;v_previous fountain_private.entities;
 v_found_previous boolean;v_affected bigint;v_data jsonb;v_change_kind text;v_change_id text;v_meta_key text;v_steps bigint:=0;v_owner_mutated boolean:=false;v_origin jsonb;v_parent_actor jsonb;v_previous_actor text;
BEGIN
 v_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
 IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 PERFORM fountain_cloud.member_deprovision_preflight(p_workspace_id,p_changes);
 FOR v_change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  IF jsonb_typeof(v_change) IS DISTINCT FROM 'object' OR jsonb_typeof(v_change->'op') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023';
  END IF;
  IF v_change->>'op' IN ('put','delete') THEN
   v_change_kind:=v_change->>'kind';v_change_id:=v_change->>'id';
   IF jsonb_typeof(v_change->'kind') IS DISTINCT FROM 'string' OR v_change_kind !~ '^[a-z][a-z0-9_]{0,63}$' OR v_change_kind IN ('credential','session')
    OR jsonb_typeof(v_change->'id') IS DISTINCT FROM 'string' OR length(v_change_id) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023';
   END IF;
   IF v_change_kind='member' AND EXISTS(SELECT 1 FROM fountain_private.entities e
     WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id=v_change_id AND e.data->>'role'='owner') THEN
    v_owner_mutated:=true;
   END IF;
   IF v_change->>'op'='put' THEN
    IF NOT(v_change ?& ARRAY['op','kind','id','data','previousCreatedAt']) OR v_change-ARRAY['op','kind','id','data','previousCreatedAt','origin']<>'{}'::jsonb
     OR jsonb_typeof(v_change->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    v_data:=v_change->'data';
    IF btrim(v_change_id)='' OR v_data->>'id' IS DISTINCT FROM v_change_id OR jsonb_typeof(v_data->'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_data->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v_data->'updated_at') IS DISTINCT FROM 'string'
     OR length(v_data->>'created_at') NOT BETWEEN 1 AND 64 OR length(v_data->>'updated_at') NOT BETWEEN 1 AND 64
     OR v_change_kind='attachment' AND v_data ? 'data' THEN RAISE EXCEPTION 'Invalid entity data' USING ERRCODE='22023'; END IF;
    v_origin:=NULL;
    IF v_change ? 'origin' THEN
     v_origin:=v_change->'origin';
     BEGIN v_parent_actor:=NULLIF(current_setting('fountain.content_actor',true),'')::jsonb;EXCEPTION WHEN invalid_text_representation THEN v_parent_actor:=NULL;END;
     IF jsonb_typeof(v_origin) IS DISTINCT FROM 'object' OR NOT(v_origin ?& ARRAY['member_id','cause']) OR v_origin-ARRAY['member_id','cause']<>'{}'::jsonb
      OR jsonb_typeof(v_origin->'member_id') IS DISTINCT FROM 'string' OR length(v_origin->>'member_id') NOT BETWEEN 1 AND 160
      OR jsonb_typeof(v_origin->'cause') IS DISTINCT FROM 'string' OR v_origin->>'cause' NOT IN('human','automation','import','public_form')
      OR v_parent_actor->>'workspace_id' IS DISTINCT FROM v_ws OR jsonb_typeof(v_parent_actor->'member_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_parent_actor->>'cause','') NOT IN('human','automation','import','public_form','system','scim')
      OR(v_origin->>'cause'<>'automation' AND v_origin->>'member_id' IS DISTINCT FROM v_parent_actor->>'member_id')
      OR NOT EXISTS(SELECT 1 FROM fountain_private.entities a WHERE a.workspace_id=v_ws AND a.kind='member' AND a.id=v_origin->>'member_id'
       AND a.data->>'id'=a.id AND COALESCE(a.data->'active','true'::jsonb)='true'::jsonb
       AND a.data->>'role'=ANY(CASE WHEN v_origin->>'cause'='automation' THEN ARRAY['owner','admin','member'] ELSE ARRAY['owner','admin','member','guest'] END))
      OR NOT EXISTS(SELECT 1 FROM fountain_private.entities a WHERE a.workspace_id=v_ws AND a.kind='member' AND a.id=v_parent_actor->>'member_id'
       AND a.data->>'id'=a.id AND COALESCE(a.data->'active','true'::jsonb)='true'::jsonb AND a.data->>'role' IN('owner','admin','member','guest')) THEN
      RAISE EXCEPTION 'Invalid trusted content origin' USING ERRCODE='22023';
     END IF;
    END IF;
    SELECT * INTO v_previous FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    v_found_previous:=FOUND;
    IF (v_found_previous AND (v_change->'previousCreatedAt' IS DISTINCT FROM to_jsonb(v_previous.created_at) OR v_data->>'created_at' IS DISTINCT FROM v_previous.created_at))
     OR (NOT v_found_previous AND v_change->'previousCreatedAt' IS DISTINCT FROM 'null'::jsonb) THEN
     RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
    END IF;
    v_previous_actor:=current_setting('fountain.content_actor',true);
    IF v_origin IS NOT NULL THEN PERFORM set_config('fountain.content_actor',(v_origin||jsonb_build_object('workspace_id',v_ws))::text,true);END IF;
    BEGIN
    INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at)
    VALUES(v_ws,v_change_kind,v_change_id,v_data,v_data->>'created_at',v_data->>'updated_at')
    ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at;
    EXCEPTION WHEN OTHERS THEN
     PERFORM set_config('fountain.content_actor',COALESCE(v_previous_actor,''),true);RAISE;
    END;
    PERFORM set_config('fountain.content_actor',COALESCE(v_previous_actor,''),true);
    v_steps:=v_steps+1;
   ELSE
    IF NOT(v_change ?& ARRAY['op','kind','id']) OR v_change-ARRAY['op','kind','id']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    DELETE FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    GET DIAGNOSTICS v_affected=ROW_COUNT;v_steps:=v_steps+v_affected;
   END IF;
  ELSIF v_change->>'op'='meta' THEN
   v_meta_key:=v_change->>'key';
   IF NOT(v_change ?& ARRAY['op','key','value']) OR v_change-ARRAY['op','key','value']<>'{}'::jsonb
    OR jsonb_typeof(v_change->'key') IS DISTINCT FROM 'string' OR length(v_meta_key) NOT BETWEEN 1 AND 160
    OR v_meta_key IN ('_entity_revision','local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved')
    OR v_meta_key='workspace_id' AND v_change->'value' IS DISTINCT FROM to_jsonb(v_ws) THEN RAISE EXCEPTION 'Invalid metadata change' USING ERRCODE='22023'; END IF;
   INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,v_meta_key,v_change->'value')
   ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
   v_steps:=v_steps+1;
  ELSE RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Evaluate the final transaction state, including multi-member changes.
 -- Legacy password hashes never prove that a Supabase owner can log in.
 IF v_owner_mutated THEN
  PERFORM 1 FROM fountain_private.entities e
   JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id
   JOIN auth.users u ON u.id=m.auth_user_id
   WHERE e.workspace_id=v_ws AND e.kind='member' AND e.data->>'id'=e.id AND e.data->>'role'='owner'
    AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
    AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
    AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
    AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
    AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   ORDER BY u.id FOR SHARE OF e,m,u;
  IF NOT FOUND THEN RAISE EXCEPTION 'LAST_OWNER_ACCOUNT' USING ERRCODE='PT409'; END IF;
 END IF;
 IF v_revision+v_steps>9007199254740991 THEN RAISE EXCEPTION 'Revision limit exceeded' USING ERRCODE='PT413'; END IF;
 v_revision:=v_revision+v_steps;
 IF v_steps>0 THEN
  INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,'_entity_revision',to_jsonb(v_revision))
  ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 END IF;
 RETURN v_revision;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.store_apply_changes_locked(text,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Verified actor context surrounds only the unchanged staged mutation kernel.
CREATE OR REPLACE FUNCTION fountain_cloud.store_commit(p_context jsonb, p_expected_revision bigint, p_transaction_id uuid, p_digest text, p_canonical text, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE ws text;actor_id text;revision bigint;recorded fountain_cloud.store_commit_receipts;v_content_actor text;
BEGIN
 -- Always authenticate BEFORE replay ACK, including a previously committed tx.
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';actor_id:=p_context->>'memberId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_transaction_id IS NULL
  OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>16777216
  OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid commit' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_changes)>1000 OR octet_length(p_changes::text)>16777216 THEN
  RAISE EXCEPTION 'Commit limit exceeded' USING ERRCODE='PT413';
 END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest
  OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes) THEN
  RAISE EXCEPTION 'Invalid commit digest' USING ERRCODE='22023';
 END IF;
 SELECT * INTO recorded FROM fountain_cloud.store_commit_receipts r
 WHERE r.workspace_id=ws AND r.member_id=actor_id AND r.session_hash=p_context->>'sessionHash' AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF recorded.digest<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('revision',recorded.result_revision);
 END IF;
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');
 IF revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409'; END IF;
 v_content_actor:=current_setting('fountain.content_actor',true);
 PERFORM set_config('fountain.content_actor',jsonb_build_object('workspace_id',ws,'member_id',actor_id,'cause','human')::text,true);
 BEGIN
  revision:=fountain_cloud.store_apply_changes_locked(ws,p_expected_revision,p_changes);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);RAISE;END;
 PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);
 INSERT INTO fountain_cloud.store_commit_receipts(workspace_id,member_id,session_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(ws,actor_id,p_context->>'sessionHash',p_transaction_id,p_digest,p_expected_revision,revision);
 RETURN jsonb_build_object('revision',revision);
END $function$;
CREATE OR REPLACE FUNCTION fountain_cloud.service_commit(p_context jsonb,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_principal jsonb;v_ws text;v_scope text;v_recorded fountain_cloud.service_commit_receipts;v_revision bigint;
 v_job fountain_cloud.scheduler_jobs;v_final_run jsonb;v_final_auto jsonb;v_stamp text;v_next jsonb;v_content_actor text;
BEGIN
 v_principal:=fountain_cloud.service_context(p_context);
 IF v_principal IS NULL THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
 PERFORM fountain_cloud.scheduler_identity_guard(p_context);
 v_ws:=p_context->>'workspaceId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_transaction_id IS NULL
  OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>16777216
  OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid commit' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_changes)>1000 OR octet_length(p_changes::text)>16777216 THEN RAISE EXCEPTION 'Commit limit exceeded' USING ERRCODE='PT413';END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest
  OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes) THEN RAISE EXCEPTION 'Invalid commit digest' USING ERRCODE='22023';END IF;
 v_scope:=encode(sha256(convert_to(p_context::text,'UTF8')),'hex');
 SELECT r.* INTO v_recorded FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=(p_context->>'grantId')::uuid AND r.authority_hash=v_scope AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF v_recorded.digest<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409';END IF;
  RETURN jsonb_build_object('revision',v_recorded.result_revision);
 END IF;
 PERFORM fountain_cloud.service_data_ready(p_context);PERFORM fountain_cloud.service_changes(p_context,p_changes);
 IF p_context->>'kind'='automation' THEN
  v_job:=fountain_cloud.scheduler_service_ready(p_context);v_stamp:=fountain_cloud.scheduler_stamp(v_job.fixed_now);v_next:=COALESCE(to_jsonb(v_job.next_at),'null'::jsonb);
  SELECT c.value->'data' INTO v_final_run FROM jsonb_array_elements(p_changes) WITH ORDINALITY c(value,ordinal)
   WHERE c.value->>'kind'='automation_run' AND c.value->>'id'=v_job.run_id AND c.value->>'op'='put' ORDER BY c.ordinal DESC LIMIT 1;
  SELECT c.value->'data' INTO v_final_auto FROM jsonb_array_elements(p_changes) WITH ORDINALITY c(value,ordinal)
   WHERE c.value->>'kind'='automation' AND c.value->>'id'=v_job.automation_id AND c.value->>'op'='put' ORDER BY c.ordinal DESC LIMIT 1;
  IF v_final_run IS NULL OR v_final_auto IS NULL OR v_final_run->'id' IS DISTINCT FROM to_jsonb(v_job.run_id) OR v_final_run->'automation_id' IS DISTINCT FROM to_jsonb(v_job.automation_id)
   OR v_final_run->'scheduled_at' IS DISTINCT FROM to_jsonb(v_job.scheduled_at) OR v_final_run->>'status' NOT IN('succeeded','failed') OR jsonb_typeof(v_final_run->'status') IS DISTINCT FROM 'string'
   OR v_final_run->'started_at' IS DISTINCT FROM to_jsonb(v_stamp) OR v_final_run->'finished_at' IS DISTINCT FROM to_jsonb(v_stamp) OR v_final_run->'next_run_at' IS DISTINCT FROM v_next
   OR v_final_auto->'next_run_at' IS DISTINCT FROM v_next OR v_final_auto->'last_run_at' IS DISTINCT FROM to_jsonb(v_stamp) OR v_final_auto->>'last_run_status' IS DISTINCT FROM v_final_run->>'status'
   OR(v_job.next_at IS NULL AND(v_final_auto->'enabled' IS DISTINCT FROM 'false'::jsonb OR v_final_auto->>'schedule_status' IS DISTINCT FROM 'completed'))
   OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation_run' AND e.id=v_job.run_id) THEN RAISE EXCEPTION 'SLOT_CHANGED' USING ERRCODE='PT409';END IF;
  -- Provisional done is visible to the source trigger only within THIS TX. An
  -- apply failure rolls this back together with all actions/due/receipt changes.
  UPDATE fountain_cloud.scheduler_jobs j SET state='done',outcome='data_'||(v_final_run->>'status'),finished_at=clock_timestamp() WHERE j.workspace_id=v_ws AND j.id=v_job.id;
 END IF;
 v_content_actor:=current_setting('fountain.content_actor',true);
 PERFORM set_config('fountain.content_actor',jsonb_build_object('workspace_id',v_ws,'member_id',v_principal->>'id','cause',CASE WHEN p_context->>'kind'='automation' THEN 'automation' ELSE 'system' END)::text,true);
 BEGIN
  v_revision:=fountain_cloud.store_apply_changes_locked(v_ws,p_expected_revision,p_changes);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);RAISE;END;
 PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);
 IF p_context->>'kind'='automation' THEN UPDATE fountain_cloud.scheduler_jobs j SET result_revision=v_revision WHERE j.workspace_id=v_ws AND j.id=v_job.id;END IF;
 INSERT INTO fountain_cloud.service_commit_receipts(workspace_id,grant_id,authority_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(v_ws,(p_context->>'grantId')::uuid,v_scope,p_transaction_id,p_digest,p_expected_revision,v_revision);
 RETURN jsonb_build_object('revision',v_revision);
END $$;

ALTER FUNCTION fountain_private.content_display(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_display(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_casefold(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_casefold(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_fold(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_fold(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_lock(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_lock(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_touch(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_touch(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_header(text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_header(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_truth(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_truth(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_date_atom(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_date_atom(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_scalar(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_scalar(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_pieces(text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_pieces(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_refresh(text,text,text,boolean,boolean,boolean,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_refresh(text,text,text,boolean,boolean,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_manage_target(text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_manage_target(text,text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_entity_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_entity_event() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_provenance_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_provenance_event() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

ALTER FUNCTION fountain_private.content_access_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.content_access_event() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

REVOKE ALL ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb),fountain_cloud.service_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
