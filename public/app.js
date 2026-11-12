"use strict";

// TaskSparkle front end.
//
// The boards live in the TaskSparkle API, not in this browser. On load
// the app fetches the signed-in person's whole state from /api/state
// and renders it. Every change paints on screen at once and sends its
// API call behind it. If a call fails, a plain error line appears and
// the app fetches the state again, so the screen never claims a change
// the server did not take.
//
// Local storage never holds the boards. It holds a small mirror
// (the signed-in person's name and a copy of the theme, so a
// reload never flashes the wrong colours) and the device
// settings: the choices that belong to this device — how names
// show themselves, the theme, and how each board was left. The
// inline script in index.html reads them before the page paints.
// The API stays the source of truth for the boards.

// The build stamp. The same stamp stands in worker.js, word for
// word: on every open the app reads the stamp the server serves
// and reloads itself once when the two disagree, before any board
// paints (see bootLoad). The deploy fails when the stamps differ,
// so they can only ever disagree in a browser still holding an
// older copy of this file — which is the case the reload cures.
var BUILD_ID = "r2026-11-07-20";

// Label colours are stored as palette ids. The person picks from this
// palette in Settings and each card chip paints itself from it. Each
// colour carries a dark set too: a darker tint behind lighter text, so
// chips stay readable when the dark theme is on.
var LABEL_PALETTE = [
  { id: "green", name: "Green", bg: "#dcead9", ink: "#234d20", border: "#b7d3b2", darkBg: "#1e3a22", darkInk: "#a9d6a4", darkBorder: "#356b3a" },
  { id: "amber", name: "Amber", bg: "#fde8c8", ink: "#6b4b00", border: "#f0d194", darkBg: "#3d2f0e", darkInk: "#f2cd7e", darkBorder: "#6e5a24" },
  { id: "blue", name: "Blue", bg: "#dbeafe", ink: "#1d3f7d", border: "#aecbf5", darkBg: "#1c2f52", darkInk: "#a9c8f5", darkBorder: "#33507e" },
  { id: "purple", name: "Purple", bg: "#ece2f5", ink: "#472a66", border: "#d0bce8", darkBg: "#2f2145", darkInk: "#cdb2ec", darkBorder: "#513873" },
  { id: "grey", name: "Grey", bg: "#e5e5e0", ink: "#3d403d", border: "#c9cdc4", darkBg: "#333633", darkInk: "#cfd4cd", darkBorder: "#565c56" },
  { id: "violet", name: "Violet", bg: "#e3e0f5", ink: "#3b2a6b", border: "#c4bce8", darkBg: "#2b2547", darkInk: "#c0b4ec", darkBorder: "#4a3f73" },
  { id: "teal", name: "Teal", bg: "#d7f0ec", ink: "#0f4c44", border: "#a5d8d0", darkBg: "#14332e", darkInk: "#93d8cc", darkBorder: "#24584f" },
  { id: "pink", name: "Pink", bg: "#fde3ef", ink: "#701a3e", border: "#f2b8d0", darkBg: "#42202f", darkInk: "#f2aecb", darkBorder: "#6e3550" },
  { id: "lime", name: "Lime", bg: "#e6f2d8", ink: "#33590f", border: "#c2dd9e", darkBg: "#2c3d16", darkInk: "#bfe08f", darkBorder: "#4c6626" },
  { id: "orange", name: "Orange", bg: "#fdebd2", ink: "#713f12", border: "#efc491", darkBg: "#3d2a10", darkInk: "#f2c48d", darkBorder: "#6b4a1e" }
];

function paletteFor(colourId) {
  for (var i = 0; i < LABEL_PALETTE.length; i++) {
    if (LABEL_PALETTE[i].id === colourId) return LABEL_PALETTE[i];
  }
  return LABEL_PALETTE[4];
}

// The three colours a palette entry paints with right now. The dark
// theme reads its shades off the data-theme attribute on <html>.
function paletteColors(palette) {
  if (document.documentElement.getAttribute("data-theme") === "dark") {
    return { bg: palette.darkBg, ink: palette.darkInk, border: palette.darkBorder };
  }
  return { bg: palette.bg, ink: palette.ink, border: palette.border };
}

// The five columns every board starts with. A board's own columns
// come back in its state and the app renders those.
var DEFAULT_COLUMN_KINDS = [
  { kind: "inbox", name: "Inbox" },
  { kind: "ready", name: "Ready" },
  { kind: "doing", name: "Doing" },
  { kind: "waiting", name: "Waiting" },
  { kind: "done", name: "Done" }
];

// --- Icons ---
//
// A board, a column, a label and a project can each carry an icon:
// one emoji, picked with the component further down and cleaned by
// the same rule the API holds. An unset board icon reads from the
// board's name and an unset column icon reads as the keycap number
// of its position; the API fills both in on read, and the two
// helpers here mirror that fill for the moments a thing exists on
// screen before its first save returns. Projects and labels have
// no default: unset is no icon.
var EMOJI_CHOICES = ["😀", "⭐", "❤️", "🏠", "👤", "🏢", "🌳", "🚗", "✈️", "🎨", "🎵", "📚", "💼", "💰", "🛒", "🍳", "⚽", "🎮", "📷", "✏️", "🔧", "💡", "🔑", "📅", "🌻", "🐶", "🌊", "⛰️", "🚲", "🎁"];

// The big emoji set the picker ships: a few hundred emoji across
// everyday categories, each with a name and a few tag words the
// picker's filter matches against. Entry shape: [emoji, name,
// tags]. The app's own default icons (the bust, the office, the
// dividers, the keycaps and every EMOJI_CHOICES entry) stand
// pinned at the picker's front; every pinned emoji stands in
// this list too, so a pick always carries its name.
var EMOJI_SET = [
  // Faces
  ["😀", "grinning face", "happy smile"], ["😁", "beaming face", "happy grin teeth"],
  ["😂", "face with tears of joy", "laugh cry funny"], ["🤣", "rolling on the floor laughing", "laugh funny"],
  ["😊", "smiling face with smiling eyes", "happy warm blush"], ["😍", "smiling face with heart-eyes", "love hearts adore"],
  ["😘", "face blowing a kiss", "kiss love"], ["😎", "smiling face with sunglasses", "cool shades"],
  ["🤩", "star-struck", "star eyes excited wow"], ["🥳", "partying face", "party celebrate hat"],
  ["😴", "sleeping face", "sleep tired zzz"], ["🤔", "thinking face", "hmm think question"],
  ["🤨", "face with raised eyebrow", "skeptical doubt"], ["😐", "neutral face", "meh blank"],
  ["🙄", "face with rolling eyes", "eyeroll annoyed"], ["😬", "grimacing face", "awkward teeth"],
  ["🤐", "zipper-mouth face", "secret quiet sealed lips"], ["🤯", "exploding head", "mind blown shock"],
  ["😱", "face screaming in fear", "scared shock scream"], ["😳", "flushed face", "embarrassed blush"],
  ["🥺", "pleading face", "puppy eyes please"], ["😢", "crying face", "sad tear"],
  ["😭", "loudly crying face", "sob sad tears"], ["😤", "face with steam from nose", "frustrated determined triumph"],
  ["😡", "pouting face", "angry mad red"], ["🤬", "face with symbols on mouth", "swearing angry curse"],
  ["😈", "smiling face with horns", "devil mischief"], ["💀", "skull", "dead death spooky"],
  ["💩", "pile of poo", "poop funny"], ["🤡", "clown face", "clown circus"],
  ["👻", "ghost", "spooky halloween boo"], ["👽", "alien", "ufo space"],
  ["🤖", "robot", "bot machine ai"], ["😺", "grinning cat", "cat happy"],
  ["😻", "smiling cat with heart-eyes", "cat love"], ["🙈", "see-no-evil monkey", "monkey hide eyes"],
  ["🙉", "hear-no-evil monkey", "monkey ears"], ["🙊", "speak-no-evil monkey", "monkey mouth quiet"],
  // Hands and people
  ["👋", "waving hand", "hello hi wave bye"], ["✋", "raised hand", "stop high five"],
  ["👌", "OK hand", "ok perfect"], ["🤞", "crossed fingers", "luck hope wish"],
  ["✌️", "victory hand", "peace two"], ["🤟", "love-you gesture", "sign love"],
  ["👍", "thumbs up", "yes good approve like"], ["👎", "thumbs down", "no bad dislike"],
  ["👏", "clapping hands", "applause bravo"], ["🙌", "raising hands", "celebrate hooray"],
  ["🙏", "folded hands", "please pray thanks hope"], ["💪", "flexed biceps", "strong muscle gym"],
  ["🫶", "heart hands", "love hearts"], ["✍️", "writing hand", "write pen note"],
  ["👤", "bust in silhouette", "person user profile account default"], ["🧑", "person", "adult human"],
  ["👶", "baby", "infant child"], ["🧓", "older person", "elder senior"],
  ["👮", "police officer", "cop law"], ["🧑‍🚀", "astronaut", "space rocket"],
  ["🧑‍🎨", "artist", "art paint creative"], ["🧑‍💻", "technologist", "computer code work laptop"],
  ["🧑‍🌾", "farmer", "farm garden"], ["🧑‍🍳", "cook", "chef kitchen food"],
  ["🧑‍🔧", "mechanic", "fix repair tools"], ["🦸", "superhero", "hero cape"],
  ["🧙", "mage", "wizard magic"], ["🧚", "fairy", "magic wings"],
  ["🧛", "vampire", "halloween fangs"], ["💃", "woman dancing", "dance party"],
  ["🏃", "person running", "run fast exercise"], ["🚶", "person walking", "walk stroll"],
  ["🧘", "person in lotus position", "yoga meditate calm"],
  // Animals
  ["🐶", "dog face", "puppy pet"], ["🐱", "cat face", "kitten pet"],
  ["🐭", "mouse face", "mouse"], ["🐹", "hamster", "pet"],
  ["🐰", "rabbit face", "bunny easter"], ["🦊", "fox", "clever"],
  ["🐻", "bear", "teddy"], ["🐼", "panda", "bear china"],
  ["🐨", "koala", "australia"], ["🐯", "tiger face", "tiger"],
  ["🦁", "lion", "king safari"], ["🐮", "cow face", "cow farm milk"],
  ["🐷", "pig face", "pig farm"], ["🐸", "frog", "toad pond"],
  ["🐵", "monkey face", "monkey"], ["🐔", "chicken", "hen farm egg"],
  ["🐧", "penguin", "bird antarctic"], ["🐦", "bird", "tweet flying"],
  ["🦉", "owl", "wise night"], ["🦄", "unicorn", "magic rainbow"],
  ["🐝", "honeybee", "bee buzz honey"], ["🦋", "butterfly", "insect pretty"],
  ["🐢", "turtle", "slow shell"], ["🐙", "octopus", "sea tentacles"],
  ["🐠", "tropical fish", "fish sea"], ["🐳", "spouting whale", "whale ocean"],
  ["🦈", "shark", "ocean jaws"], ["🐴", "horse face", "horse farm ride"],
  ["🦌", "deer", "forest antlers"], ["🐘", "elephant", "safari big"],
  ["🦩", "flamingo", "pink bird"], ["🦜", "parrot", "bird talk tropical"],
  ["🐺", "wolf", "wild dog"], ["🦔", "hedgehog", "spiky pet"],
  ["🐌", "snail", "slow shell"], ["🐞", "lady beetle", "ladybug insect luck"],
  ["🕷️", "spider", "web halloween"], ["🦗", "cricket", "insect chirp"],
  ["🐍", "snake", "serpent slither"],
  // Nature and weather
  ["🌳", "deciduous tree", "tree green park"], ["🌲", "evergreen tree", "pine forest christmas"],
  ["🌴", "palm tree", "tropical beach island"], ["🌵", "cactus", "desert plant"],
  ["🌷", "tulip", "flower spring"], ["🌹", "rose", "flower love red"],
  ["🌻", "sunflower", "flower summer sun"], ["🌼", "blossom", "flower spring"],
  ["🍀", "four leaf clover", "luck irish shamrock"], ["🍁", "maple leaf", "autumn fall canada"],
  ["🍂", "fallen leaf", "autumn fall"], ["🌱", "seedling", "sprout grow plant new"],
  ["🌊", "water wave", "ocean sea surf"], ["🔥", "fire", "flame hot lit"],
  ["☀️", "sun", "sunny weather hot"], ["🌙", "crescent moon", "night sleep"],
  ["⭐", "star", "favourite rating night"], ["🌈", "rainbow", "colour weather pride"],
  ["☁️", "cloud", "weather sky"], ["❄️", "snowflake", "snow winter cold"],
  ["⛄", "snowman", "winter snow"], ["🌧️", "cloud with rain", "rain weather"],
  ["⛈️", "cloud with lightning and rain", "storm thunder weather"], ["🌍", "globe showing Europe and Africa", "earth world planet"],
  ["🏔️", "snow-capped mountain", "mountain peak hike"], ["⛰️", "mountain", "peak hike climb"],
  ["🏖️", "beach with umbrella", "beach holiday sand"], ["🏜️", "desert", "sand dry"],
  ["🌋", "volcano", "eruption lava"], ["💧", "droplet", "water rain drop"],
  ["🌿", "herb", "leaf plant green"], ["🍄", "mushroom", "fungus forest"],
  ["🌾", "sheaf of rice", "grain farm harvest"], ["🌸", "cherry blossom", "flower spring pink japan"],
  ["🌺", "hibiscus", "flower tropical"],
  // Food and drink
  ["🍎", "red apple", "fruit healthy"], ["🍐", "pear", "fruit"],
  ["🍊", "tangerine", "orange fruit"], ["🍋", "lemon", "fruit sour"],
  ["🍌", "banana", "fruit"], ["🍉", "watermelon", "fruit summer"],
  ["🍇", "grapes", "fruit wine"], ["🍓", "strawberry", "fruit berry"],
  ["🫐", "blueberries", "fruit berry"], ["🍒", "cherries", "fruit"],
  ["🍑", "peach", "fruit"], ["🥑", "avocado", "fruit toast"],
  ["🥕", "carrot", "vegetable garden"], ["🌽", "ear of corn", "corn vegetable"],
  ["🥦", "broccoli", "vegetable green"], ["🍅", "tomato", "vegetable red"],
  ["🥔", "potato", "vegetable"], ["🍞", "bread", "loaf bakery"],
  ["🥐", "croissant", "bread french"], ["🧀", "cheese wedge", "cheese dairy"],
  ["🍳", "cooking", "egg frying breakfast"], ["🥞", "pancakes", "breakfast syrup"],
  ["🍔", "hamburger", "burger fast food"], ["🍟", "french fries", "chips fast food"],
  ["🍕", "pizza", "slice italian fast food"], ["🌮", "taco", "mexican food"],
  ["🌯", "burrito", "mexican wrap"], ["🍣", "sushi", "japanese fish"],
  ["🍜", "steaming bowl", "noodles ramen soup"], ["🍝", "spaghetti", "pasta italian"],
  ["🍦", "soft ice cream", "dessert sweet"], ["🍩", "doughnut", "donut sweet"],
  ["🍪", "cookie", "biscuit sweet bake"], ["🎂", "birthday cake", "cake celebrate party"],
  ["🍰", "shortcake", "cake slice dessert"], ["🍫", "chocolate bar", "chocolate sweet"],
  ["🍬", "candy", "sweet"], ["☕", "hot beverage", "coffee tea cup morning"],
  ["🍵", "teacup without handle", "tea green"], ["🍺", "beer mug", "beer drink pub"],
  ["🍷", "wine glass", "wine drink"], ["🥤", "cup with straw", "soda drink"],
  ["🧋", "bubble tea", "boba drink"], ["🥛", "glass of milk", "milk dairy drink"],
  ["🍾", "bottle with popping cork", "champagne celebrate"], ["🥂", "clinking glasses", "cheers toast celebrate"],
  ["🍽️", "fork and knife with plate", "dinner eat restaurant"], ["🥗", "green salad", "salad healthy bowl"],
  ["🍿", "popcorn", "movie snack"], ["🧁", "cupcake", "cake sweet bake"],
  ["🥧", "pie", "bake dessert"], ["🍯", "honey pot", "honey sweet bee"],
  // Activities and sport
  ["⚽", "soccer ball", "football sport"], ["🏀", "basketball", "sport hoop"],
  ["🏈", "american football", "sport"], ["⚾", "baseball", "sport"],
  ["🎾", "tennis", "sport ball"], ["🏐", "volleyball", "sport beach"],
  ["🏒", "ice hockey stick and puck", "sport canada"], ["⛳", "flag in hole", "golf sport"],
  ["🎣", "fishing pole", "fishing hobby"], ["🎮", "video game", "gaming controller play"],
  ["🎲", "game die", "dice board game chance"], ["🎯", "direct hit", "target bullseye aim darts"],
  ["🎳", "bowling", "sport pins"], ["🏆", "trophy", "win champion award first"],
  ["🥇", "1st place medal", "gold win first"], ["🏅", "sports medal", "award win"],
  ["🎨", "artist palette", "art paint creative colour"], ["🎭", "performing arts", "theatre masks drama"],
  ["🎵", "musical note", "music song"], ["🎸", "guitar", "music rock instrument"],
  ["🎹", "musical keyboard", "piano music keys"], ["🎻", "violin", "music classical"],
  ["🥁", "drum", "music beat"], ["🎤", "microphone", "sing karaoke music"],
  ["🎧", "headphone", "music listen audio"], ["✏️", "pencil", "write draw school"],
  ["🖌️", "paintbrush", "art paint"], ["🧶", "yarn", "knit craft"],
  ["🧵", "thread", "sew craft"], ["🏊", "person swimming", "swim pool"],
  ["🚴", "person biking", "cycle bike ride"], ["🏋️", "person lifting weights", "gym strong workout"],
  ["🧗", "person climbing", "climb rock"], ["🏕️", "camping", "tent outdoors"],
  ["🎢", "roller coaster", "fair ride fun"], ["🎡", "ferris wheel", "fair ride"],
  ["🎠", "carousel horse", "fair ride"], ["🏄", "person surfing", "surf beach wave"],
  ["🚣", "person rowing boat", "row boat lake"], ["🎿", "skis", "ski winter snow"],
  ["⛸️", "ice skate", "skating winter"], ["🎩", "top hat", "magician formal"],
  ["🎓", "graduation cap", "school graduate degree"], ["🎬", "clapper board", "film movie video"],
  ["🎥", "movie camera", "film video"],
  // Travel and places
  ["🚗", "automobile", "car drive road"], ["🚕", "taxi", "cab ride"],
  ["🚙", "sport utility vehicle", "car vehicle"], ["🚌", "bus", "transport ride"],
  ["🚲", "bicycle", "bike cycle ride"], ["🛵", "motor scooter", "vespa ride"],
  ["🏍️", "motorcycle", "bike ride"], ["✈️", "airplane", "flight travel plane"],
  ["🚀", "rocket", "space launch ship"], ["🚁", "helicopter", "fly"],
  ["⛵", "sailboat", "sail boat sea"], ["🚢", "ship", "boat cruise sea"],
  ["🚂", "locomotive", "train rail"], ["🏠", "house", "home building"],
  ["🏡", "house with garden", "home"], ["🏢", "office building", "work city default"],
  ["🏥", "hospital", "medical health"], ["🏦", "bank", "money building"],
  ["🏪", "convenience store", "shop store"], ["🏫", "school", "education building"],
  ["⛪", "church", "building worship"], ["🗽", "Statue of Liberty", "new york america"],
  ["🗼", "Tokyo tower", "japan tower"], ["🏰", "castle", "fortress royal"],
  ["⛺", "tent", "camp outdoors"], ["🌉", "bridge at night", "bridge city"],
  ["🚦", "vertical traffic light", "stop go road"], ["⛽", "fuel pump", "gas petrol station"],
  ["🧭", "compass", "direction navigate explore"], ["🗺️", "world map", "travel map explore"],
  ["🚐", "minivan", "van vehicle"], ["🛻", "pickup truck", "truck vehicle"],
  ["🚜", "tractor", "farm vehicle"], ["🏎️", "racing car", "fast race"],
  ["🚓", "police car", "cop law"], ["🚑", "ambulance", "emergency medical"],
  ["🚒", "fire engine", "fire truck emergency"], ["🛶", "canoe", "boat paddle lake"],
  ["🚤", "speedboat", "boat fast water"], ["⚓", "anchor", "ship sea boat"],
  ["🧳", "luggage", "travel suitcase trip"], ["🏨", "hotel", "stay travel"],
  ["🌆", "cityscape at dusk", "city evening"], ["🏙️", "cityscape", "city buildings"],
  // Objects
  ["📱", "mobile phone", "phone call mobile"], ["💻", "laptop", "computer work"],
  ["🖥️", "desktop computer", "computer screen"], ["⌚", "watch", "time clock wrist"],
  ["📷", "camera", "photo picture"], ["📺", "television", "tv watch show"],
  ["📻", "radio", "music listen"], ["🔑", "key", "lock open password"],
  ["🔒", "locked", "lock secure private"], ["🔓", "unlocked", "lock open"],
  ["🔨", "hammer", "tool build fix"], ["🔧", "wrench", "tool fix repair"],
  ["🪛", "screwdriver", "tool fix"], ["⚙️", "gear", "settings machine cog"],
  ["💡", "light bulb", "idea bright think"], ["🔦", "flashlight", "torch light"],
  ["🕯️", "candle", "light flame"], ["📅", "calendar", "date schedule plan"],
  ["📆", "tear-off calendar", "date schedule"], ["📋", "clipboard", "list tasks notes"],
  ["📌", "pushpin", "pin note board"], ["📎", "paperclip", "attach office"],
  ["✂️", "scissors", "cut craft"], ["📏", "straight ruler", "measure school"],
  ["📐", "triangular ruler", "measure geometry"], ["📚", "books", "read study library"],
  ["📖", "open book", "read story"], ["📝", "memo", "note write list"],
  ["✉️", "envelope", "mail letter email"], ["📦", "package", "box parcel delivery"],
  ["🎁", "wrapped gift", "present birthday gift"], ["💰", "money bag", "money rich cash"],
  ["💳", "credit card", "pay money bank"], ["💵", "dollar banknote", "money cash"],
  ["🪙", "coin", "money gold"], ["⚖️", "balance scale", "justice law weigh"],
  ["🧲", "magnet", "attract science"], ["🔭", "telescope", "stars space science"],
  ["🔬", "microscope", "science lab"], ["💊", "pill", "medicine health"],
  ["🩺", "stethoscope", "doctor medical health"], ["🌡️", "thermometer", "temperature weather health"],
  ["🛏️", "bed", "sleep rest hotel"], ["🛋️", "couch and lamp", "sofa living room rest"],
  ["🚪", "door", "entry room"], ["🪑", "chair", "sit furniture"],
  ["🧹", "broom", "clean sweep"], ["🧺", "basket", "laundry picnic carry"],
  ["🛁", "bathtub", "bath wash"], ["🚿", "shower", "wash water"],
  ["🔔", "bell", "ring alert notify"], ["📣", "megaphone", "announce loud shout"],
  ["📢", "loudspeaker", "announce speaker"], ["💬", "speech balloon", "chat talk message comment"],
  ["💭", "thought balloon", "think dream idea"], ["🗂️", "card index dividers", "organise files board folders default"],
  ["🗃️", "card file box", "archive files box"], ["🗄️", "file cabinet", "files office archive"],
  ["🗑️", "wastebasket", "trash bin delete"], ["🖼️", "framed picture", "art photo frame gallery"],
  ["🪴", "potted plant", "plant home green"], ["🧸", "teddy bear", "toy soft kids"],
  ["🎈", "balloon", "party celebrate"], ["🎉", "party popper", "celebrate confetti party"],
  ["🎊", "confetti ball", "celebrate party"], ["🏮", "red paper lantern", "light festival"],
  ["🪩", "mirror ball", "disco party dance"], ["🔮", "crystal ball", "fortune magic future"],
  ["🪄", "magic wand", "magic spell wizard"], ["🎰", "slot machine", "gamble casino"],
  ["🕰️", "mantelpiece clock", "time antique"], ["⏰", "alarm clock", "time wake morning"],
  ["⏱️", "stopwatch", "time timer sport"], ["⌛", "hourglass done", "time wait sand"],
  ["📡", "satellite antenna", "signal dish space"], ["🔋", "battery", "power charge"],
  ["🔌", "electric plug", "power socket charge"], ["💾", "floppy disk", "save computer old"],
  ["💿", "optical disk", "cd dvd music"], ["📼", "videocassette", "vhs tape video"],
  ["🖨️", "printer", "print paper office"], ["⌨️", "keyboard", "type computer keys"],
  ["🖱️", "computer mouse", "click computer"], ["🎙️", "studio microphone", "podcast record"],
  ["💼", "briefcase", "work business office bag"], ["🛒", "shopping cart", "shop trolley groceries"],
  // Hearts and symbols
  ["❤️", "red heart", "love heart like"], ["🧡", "orange heart", "love"],
  ["💛", "yellow heart", "love"], ["💚", "green heart", "love"],
  ["💙", "blue heart", "love"], ["💜", "purple heart", "love"],
  ["🖤", "black heart", "love dark"], ["🤍", "white heart", "love pure"],
  ["💔", "broken heart", "heartbreak sad"], ["💯", "hundred points", "100 perfect score full"],
  ["✅", "check mark button", "done yes tick complete"], ["☑️", "check box with check", "done tick task"],
  ["✔️", "check mark", "tick yes"], ["❌", "cross mark", "no wrong delete x"],
  ["❓", "question mark", "help ask unknown"], ["❗", "exclamation mark", "important alert"],
  ["⚠️", "warning", "caution alert danger"], ["🚫", "prohibited", "no banned forbidden"],
  ["✨", "sparkles", "shine magic new glitter"], ["💤", "zzz", "sleep tired"],
  ["💥", "collision", "boom crash bang"], ["💦", "sweat droplets", "water splash"],
  ["♻️", "recycling symbol", "recycle green reuse"], ["🔄", "counterclockwise arrows button", "refresh repeat rotate sync"],
  ["⬆️", "up arrow", "up north direction"], ["⬇️", "down arrow", "down south"],
  ["⬅️", "left arrow", "left west back"], ["➡️", "right arrow", "right east next"],
  ["🔍", "magnifying glass tilted left", "search find zoom look"], ["🔎", "magnifying glass tilted right", "search find"],
  ["🆕", "new button", "new"], ["🆓", "free button", "free"],
  ["🆒", "cool button", "cool"], ["🆗", "ok button", "ok"],
  ["🔵", "blue circle", "dot blue"], ["🔴", "red circle", "dot red record"],
  ["🟢", "green circle", "dot green go"], ["🟡", "yellow circle", "dot yellow"],
  ["♠️", "spade suit", "cards poker"], ["♥️", "heart suit", "cards love"],
  ["♦️", "diamond suit", "cards"], ["♣️", "club suit", "cards"],
  ["🃏", "joker", "card wild"], ["🎴", "flower playing cards", "cards game"],
  ["0️⃣", "keycap 0", "zero number digit default"], ["1️⃣", "keycap 1", "one number digit first default"],
  ["2️⃣", "keycap 2", "two number digit default"], ["3️⃣", "keycap 3", "three number digit default"],
  ["4️⃣", "keycap 4", "four number digit default"], ["5️⃣", "keycap 5", "five number digit default"],
  ["6️⃣", "keycap 6", "six number digit default"], ["7️⃣", "keycap 7", "seven number digit default"],
  ["8️⃣", "keycap 8", "eight number digit default"], ["9️⃣", "keycap 9", "nine number digit default"],
  ["🔟", "keycap 10", "ten number digit default"], ["#️⃣", "keycap number sign", "hash pound number"],
  ["*️⃣", "keycap asterisk", "star asterisk"], ["🔢", "input numbers", "numbers digits"],
  ["🔤", "input latin letters", "letters abc alphabet"]
];

// The picker's pinned run: the app's own defaults — the icons a
// board, column, label or project falls back to — in front, so a
// changed icon is one tap back to the default it came from.
var PINNED_ICONS = ["👤", "🏢", "🗂️",
  "0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
  .concat(EMOJI_CHOICES.filter(function (emoji, i, all) {
    return ["👤", "🏢"].indexOf(emoji) === -1 && all.indexOf(emoji) === i;
  }));

var EMOJI_BY_CHAR = {};
EMOJI_SET.forEach(function (entry) { EMOJI_BY_CHAR[entry[0]] = entry; });
var COLUMN_NUMBER_ICONS = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

function boardIconDefault(board) {
  if (!board) return "🗂️";
  if (board.name === "Personal") return "👤";
  if (board.name === "Professional") return "🏢";
  return "🗂️";
}

function boardIcon(board) {
  return (board && board.icon) || boardIconDefault(board);
}

function columnIcon(column) {
  if (!column) return "🔢";
  if (column.icon) return column.icon;
  var position = Number(column.position) || 0;
  return COLUMN_NUMBER_ICONS[position] || "🔢";
}

function graphemeCount(value) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    var segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value)).length;
  }
  return Array.from(value.replace(/[\uFE0F\u20E3\u200D]/g, "")).length;
}

// The picker's own copy of the API's icon rule: one emoji, or the
// empty string to clear. Anything else reads back as null, and the
// picker shows its message and keeps the old icon.
function cleanIconValue(value) {
  if (value == null) return "";
  var text = String(value).trim();
  if (!text) return "";
  if (text.length > 16) return null;
  if (graphemeCount(text) !== 1) return null;
  if (!/[\u20E3\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(text)) return null;
  return text;
}

// --- Device settings ---
//
// Settings that belong to a device rather than to the person live
// here, in this browser's own storage: never sent to the API and
// never part of the boards' state. They are how board buttons and
// column names show themselves (icon and word together, the word
// alone, or the icon alone), the theme this device wears, how
// each board was left when the person last stood on it — the
// project filter and the column in view — and where the person
// last stood overall: the board on screen, whether the schedule
// stood open and on which tag, and whether the overview stood
// open, so a refresh returns to the same place. They can differ
// between a person's phone and their computer on purpose.
var DEVICE_KEY = "tasksparkle-device";

function readDeviceSettings() {
  try {
    var raw = localStorage.getItem(DEVICE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (e) { /* A broken store reads as every setting at its default. */ }
  return {};
}

function writeDeviceSettings(settings) {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(settings));
  } catch (e) { /* The choices still apply for this visit. */ }
}

// The header's display button steps through these three, in this
// order, and back to the start. The button previews the step a tap
// will take: its glyph is the next mode's and its label names the
// tap's action. The glyphs are drawn in the same stroke family as
// the theme button's: a framed mark beside lines for both together,
// lines alone for words, a star alone for icons.
var DISPLAY_MODES = ["both", "words", "icons"];
var DISPLAY_NEXT_LABELS = {
  both: "Show icons and words",
  words: "Show words only",
  icons: "Show icons only"
};
var DISPLAY_ICONS = {
  both: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 4h7"/><path d="M14 9h7"/><path d="M14 15h7"/><path d="M14 20h7"/></svg>',
  words: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18"/><path d="M3 12h18"/><path d="M3 19h10"/></svg>',
  icons: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>'
};

function displayMode() {
  var settings = readDeviceSettings();
  if (DISPLAY_MODES.indexOf(settings.displayMode) !== -1) return settings.displayMode;
  // A device that still holds the old icons-only switch starts in
  // Icons when that switch was on, and in Both when it was off.
  return settings.boardIconsOnly ? "icons" : "both";
}

function applyDisplayMode() {
  var mode = displayMode();
  var root = document.documentElement;
  root.classList.toggle("display-both", mode === "both");
  root.classList.toggle("display-words", mode === "words");
  root.classList.toggle("display-icons", mode === "icons");
  var btn = document.getElementById("display-toggle");
  if (btn) {
    var next = DISPLAY_MODES[(DISPLAY_MODES.indexOf(mode) + 1) % DISPLAY_MODES.length];
    btn.innerHTML = DISPLAY_ICONS[next];
    btn.setAttribute("aria-label", DISPLAY_NEXT_LABELS[next]);
    btn.setAttribute("title", DISPLAY_NEXT_LABELS[next]);
  }
}

function setDisplayMode(mode) {
  var settings = readDeviceSettings();
  settings.displayMode = mode;
  // The old switch is gone once the mode is written; the mode is
  // the only word on the subject from here on.
  delete settings.boardIconsOnly;
  writeDeviceSettings(settings);
  applyDisplayMode();
}

function cycleDisplayMode() {
  var next = DISPLAY_MODES[(DISPLAY_MODES.indexOf(displayMode()) + 1) % DISPLAY_MODES.length];
  setDisplayMode(next);
}

// --- State ---

// state is null until /api/state lands. Its shape is the API's shape:
// { me, theme, key, boards, labels, projects, cards } plus the view
// state this browser holds for itself (the active board and column
// and the project filter), which is never sent anywhere.
var state = null;
var editingId = null;

// The open editor's session with the server's copy of its card:
// the values both sides agreed on when the editor opened (base),
// the server's latest known values (server), and the action a
// stopped save was on its way to when a conflict stopped it. The
// session is what lets the editor save only the fields the person
// changed and stop to ask when both sides changed the same field.
var editorSession = null;
var editorPendingAfterConflict = null;
// Editor field saves still landing, and a close that is
// waiting on them (issue #137): a close never outruns a save
// any more. When the last save lands the close goes ahead;
// when one fails, the close is called off — the editor stays
// open with the banner standing and the person's text still
// in the fields, so an edit is never silently lost.
var editorSavesInFlight = 0;
// Hand-overs sent from the editor whose answers have not
// landed yet (issue #164): while one is out, the step painted
// on the editor's card is the person's newest word on it, and
// a state swap holds it across the swap.
var editorStepInFlight = 0;
var editorCloseWanted = false;
var editorSaveFailed = false;
var dragId = null;
// Whether the phone's overview stands: every column side by side
// as narrow strips. The choice belongs to this browser alone, the
// way the active column does, and is never sent anywhere. It
// starts closed and switching boards closes it; like the rest of
// the standing view it rides in the device settings, so a refresh
// brings it back as it was left.
var overviewOpen = false;

// The schedule: a list view of the board in view, under its
// project filter, that swaps in for the columns. It opens on the
// Dated tag — dated cards soonest first, late cards first — and
// the Undated tag gathers the board's undated cards by column.
// Browser-only state, like the overview; the pair of them and the
// board on screen make up the standing view the device settings
// remember, so a refresh reopens the schedule as it was left.
// One exception rides on the button, not the refresh: pressing
// Schedule to open it on a scope holding no dated cards shows it
// on Undated for that opening (issue #33, in toggleSchedule
// below), without moving the remembered tag.
var scheduleOpen = false;
var scheduleTag = "dated";

// The Archived list under the board: it stands closed — its
// heading line names how many cards it holds — and a tap on
// the line opens it; a tap again closes it. The open state
// belongs to the board in view: every board starts it closed,
// and coming back to a board starts it closed again, which
// renderArchived holds by remembering which board the state
// was last read for.
var archivedOpen = false;
var archivedOpenBoard = null;

// The tag the open schedule is showing. It is the remembered
// tag, except for the one opening issue #33 names: pressing
// Schedule on a scope with no dated cards in it shows Undated
// for that opening even when the remembered tag says Dated.
// Tapping a tag by hand moves both, so a person's own choice is
// always what is remembered.
var scheduleShownTag = "dated";

function toggleSchedule() {
  scheduleOpen = !scheduleOpen;
  if (scheduleOpen) {
    overviewOpen = false;
    // The opening choice (issue #33): dated cards in scope, the
    // schedule shows the remembered tag exactly as it always
    // has; none, it shows Undated for this opening. The count
    // is the Dated list's own — the scoped cards carrying a due
    // date — and a board whose only dated cards are archived
    // counts as no dated cards, the way its Dated list would
    // read empty.
    scheduleShownTag = scheduleScopedCards().some(function (c) { return !!c.due; })
      ? scheduleTag
      : "undated";
  }
  render();
  paintBackToTop();
}

// The See all columns button, pinned at the right of the phone's
// board row: it swaps the one column in view for every column
// side by side, and back. On a wide screen the button is never
// shown and the columns simply stand.
function toggleOverview() {
  overviewOpen = !overviewOpen;
  render();
}
// The boards whose columns, labels and projects the Settings
// sections are showing. Each section's own picker sets its one,
// and opening a section starts it from the board on screen in
// the main view (issue #96).
var columnsSettingsBoardId = null;
var labelsSettingsBoardId = null;
var projectsSettingsBoardId = null;
// Which Settings page is showing, by section id. Null means the
// Settings list itself. Settings always opens at the list, so this
// starts null and closeSettings puts it back to null.
var settingsPage = null;
// The Settings pages, in the order the list names them. The
// Admin page stands in the list only for an administrator, on
// either door: its nav entry starts hidden and the probe in
// openSettings unhides it when the server's own people route
// answers for this caller (see there).
var SETTINGS_PAGES = [
  "settings-people",
  "settings-theme",
  "settings-boards",
  "settings-columns-section",
  "settings-labels-section",
  "settings-projects-section",
  "setup-agent"
];
// The People page's last read from the sign-in routes:
// {people, unclaimed, audit}, or null before the first read.
var peopleData = null;
// The person the Remove-person dialog is armed for
// ({key, name}), or null.
var personToRemove = null;
// The passkey the Remove-passkey dialog is armed for
// ({personKey, personName, credId, nickname}), or null.
var passkeyToRemove = null;
var ownPasskeyToRemove = null;
// The signed-in person's own standing as the sign-in routes
// last reported it, for the Account page's sign-in section.
var accountAuth = null;
// A guarded act waiting on its step-up proof, or null.
var pendingGuarded = null;
// The full agent key, held in memory only in the moments after it is
// made. It is never stored. Once the person leaves Settings it is
// gone, by design: only its hash exists on the server.
var justCreatedKey = null;
// The owner's keys as the Set Up Agent page last read them from the
// key list route: [{id, name, last4, created_at}], or null before
// the first read. The state itself names only the newest key, so
// the list the page manages comes from the route, fetched when the
// page opens and after every change the page makes.
var agentKeys = null;
// The key whose rename field is open on the Set Up Agent page.
// A delete asks in its own dialog instead (issue #98) and holds
// its key here, the way the card delete dialog holds its card.
var keyRenameId = null;
var keyDeleteTarget = null;

function isTempId(id) {
  return typeof id === "string" && id.indexOf("-tmp-") !== -1;
}

function tempId(prefix) {
  return prefix + "-tmp-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
}

function findBoard(id) {
  if (!state || !id) return null;
  for (var i = 0; i < state.boards.length; i++) {
    if (state.boards[i].id === id) return state.boards[i];
  }
  return null;
}

function activeBoardObj() {
  return state ? findBoard(state.activeBoard) : null;
}

function columnsOf(board) {
  if (!board || !board.columns) return DEFAULT_COLUMN_KINDS.slice();
  return board.columns.slice().sort(function (a, b) { return a.position - b.position; });
}

function findColumn(board, columnId) {
  if (!board || !board.columns) return null;
  for (var i = 0; i < board.columns.length; i++) {
    if (board.columns[i].id === columnId) return board.columns[i];
  }
  return null;
}

// A kind for a column being added: a short generated slug, unique on
// its board. The server accepts it as the column's kind, so the kind
// the column is painted with is the kind it keeps. A kind never
// changes afterwards, however the column is renamed or reordered.
function genColumnKind(board) {
  var taken = {};
  (board.columns || []).forEach(function (col) { taken[col.kind] = true; });
  var kind = "";
  do {
    kind = "c" + Math.random().toString(36).slice(2, 10);
  } while (taken[kind]);
  return kind;
}

function labelsForBoard(boardId) {
  if (!state) return [];
  return state.labels.filter(function (label) { return label.boardId === boardId; });
}

function findLabel(id, boardId) {
  var list = labelsForBoard(boardId);
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

// The labels a card wears, as label rows, in the board's label
// order. Ids that no longer name a label on the board are left out.
function cardLabels(card) {
  var order = {};
  labelsForBoard(card.boardId).forEach(function (label, i) { order[label.id] = i; });
  return (card.labels || []).filter(function (id) {
    return Object.prototype.hasOwnProperty.call(order, id);
  }).sort(function (a, b) {
    return order[a] - order[b];
  }).map(function (id) {
    return findLabel(id, card.boardId);
  });
}

// One label chip, painted the way chips read everywhere: the
// label's colours as inline styles, its icon inside before the
// name. The card's face and the editor's tick list share it.
function buildChip(label) {
  var chip = document.createElement("span");
  var chipPalette = paletteColors(paletteFor(label.colour));
  chip.className = "chip";
  chip.setAttribute("data-label", label.id);
  chip.style.background = chipPalette.bg;
  chip.style.color = chipPalette.ink;
  chip.style.borderColor = chipPalette.border;
  if (label.icon) {
    var chipIcon = document.createElement("span");
    chipIcon.className = "chip-icon";
    chipIcon.setAttribute("data-role", "chip-icon");
    chipIcon.textContent = label.icon;
    chip.appendChild(chipIcon);
  }
  var chipName = document.createElement("span");
  chipName.className = "chip-name";
  chipName.textContent = label.name;
  chip.appendChild(chipName);
  if (label.icon) chip.classList.add("has-icon");
  return chip;
}

// How a board paints a card's first label colour onto the card
// itself (issue #95). The board's labelColourMode decides:
// chip leaves the colour on the label alone, and the other
// three paint the card — background tints its face, trim rings
// it with a thick border and top sets a thick band across its
// top, a wide top border so the card's rounded corners stay
// honest. First means first in the board's own label order,
// which is the order cardLabels returns; a card with no labels
// is never painted, and the chips render in every mode — the
// paint is emphasis, never a replacement for the word. The
// colours are the label palette's own: the faded tint the chip
// itself wears, and its border shade for the lines, each in
// its dark-theme form when the dark theme is on. The text
// stays the theme's ink. Only the board's own surfaces call
// this — the card faces and the overview's rows. The editor,
// the schedule, search results and the archived list never
// paint. The overview's rows are one line tall, so there the
// lines scale down (scale "mini"): a 2px trim and a 4px top
// band where the faces wear 4px and 12px; the background is a
// fill and reads the same at either size. The element carries
// data-label-paint with the mode's name, so the shape of the
// paint is there to be checked, not just seen.
function paintCardByLabel(el, board, wornLabels, scale) {
  var mode = (board && board.labelColourMode) || "chip";
  if (mode === "chip" || !wornLabels || !wornLabels.length) return;
  var paint = paletteColors(paletteFor(wornLabels[0].colour));
  el.setAttribute("data-label-paint", mode);
  if (mode === "background") {
    el.style.background = paint.bg;
  } else if (mode === "trim") {
    el.style.borderColor = paint.border;
    el.style.borderWidth = scale === "mini" ? "2px" : "4px";
  } else if (mode === "top") {
    el.style.borderTopColor = paint.border;
    el.style.borderTopWidth = scale === "mini" ? "4px" : "12px";
  }
}

// The tag that names who stands behind a piece of work: the
// small pill a card's face wears for the key that created it,
// and a comment in the editor wears for its author — the key
// that wrote it, or the person (issue #120: every comment
// names who made it). The builder is handed the name to show,
// resolved by the server from the maker's own record as the
// work is read — the key's name as it stands now, for a card
// and a comment alike (issue #121) — so a rename renames it
// everywhere at once, and a deleted key's name stands on its
// work, because its record stands. A card the person made
// gets no tag at all. The pill carries no icon, so — the way
// a label chip with no icon does — its word stands in every
// display mode.
function buildCreatorTag(name) {
  var tag = document.createElement("span");
  tag.className = "creator-tag";
  var tagName = document.createElement("span");
  tagName.className = "creator-tag-name";
  tagName.textContent = name;
  tag.appendChild(tagName);
  return tag;
}

// The editor names the card's maker under its title (issue
// #126): "Made by" and the name in the creator-tag pill the
// comments wear, so the editor speaks one visual language.
// The name is the one the card was read with — the key's
// current name for a key-made card, resolved by the server
// from the key's record — or the person's own current name
// for a card they made, which is the same name their
// comments resolve to. Nothing is stored for this line: it
// is rebuilt from the card as read every time the editor
// opens, so a rename renames it everywhere at once. A card
// still being created names the person creating it.
function buildMakerLine(card) {
  var line = document.getElementById("made-by-line");
  line.textContent = "";
  var name = card.creatorKeyName || (state && state.me ? state.me.name : null);
  if (!name) { line.hidden = true; return; }
  line.appendChild(document.createTextNode("Made by "));
  var tag = buildCreatorTag(name);
  tag.setAttribute("title", card.creatorKeyName
    ? "Created by the " + name + " agent key"
    : "Created by " + name);
  line.appendChild(tag);
  line.hidden = false;
}

// A card's next step, read defensively (issue #119): whose
// turn the card's next step is. A card whose step was never
// set — one the app itself just made — reads as the person's
// own step, not waiting, the migration the server declares.
function stepOfCard(card) {
  var step = (card && card.step) || {};
  return {
    holder: step.holder === "agent" || step.holder === "none" ? step.holder : "owner",
    keyId: step.keyId || null,
    keyName: step.keyName || null,
    handedAt: step.handedAt || null,
    handedByKeyName: step.handedByKeyName || null,
    handedByName: step.handedByName || null,
    waiting: !!step.waiting
  };
}

// How long a hand-over has waited, in words: "just now",
// "5 minutes ago", "2 days ago". A stamp that does not parse
// reads as no time at all.
function waitedWords(iso) {
  if (!iso) return "";
  var then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  var seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  var days = Math.floor(hours / 24);
  if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
  var weeks = Math.floor(days / 7);
  return weeks + (weeks === 1 ? " week ago" : " weeks ago");
}

// The same wait in short form, for a card face's chip: "2d".
function shortWaitAge(iso) {
  if (!iso) return "";
  var then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  var minutes = Math.max(1, Math.floor((Date.now() - then) / 60000));
  if (minutes < 60) return minutes + "m";
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  var days = Math.floor(hours / 24);
  if (days < 7) return days + "d";
  return Math.floor(days / 7) + "w";
}

// The chip a card's face wears while an agent key holds its
// next step: the key's name, and — while the card waits for
// its pickup — how long it has waited, in short form. A card
// the person holds, or no one holds, wears no chip: their own
// cards are the board's ordinary case.
function buildStepChip(card) {
  var step = stepOfCard(card);
  var chip = document.createElement("span");
  chip.className = "step-chip" + (step.waiting ? " waiting" : "");
  chip.setAttribute("data-step-chip", card.id);
  if (step.waiting) chip.setAttribute("data-step-waiting", card.id);
  chip.setAttribute("title", step.waiting
    ? "Next step: " + step.keyName + " — handed over " + waitedWords(step.handedAt) + ", not picked up"
    : "Next step: " + step.keyName);
  var chipName = document.createElement("span");
  chipName.className = "step-chip-name";
  chipName.textContent = (step.keyName || "") +
    (step.waiting ? " · " + shortWaitAge(step.handedAt) : "");
  chip.appendChild(chipName);
  return chip;
}

function projectsFor(boardId) {
  if (!state) return [];
  return state.projects.filter(function (proj) { return proj.boardId === boardId; });
}

function findProject(id) {
  if (!id || !state) return null;
  for (var i = 0; i < state.projects.length; i++) {
    if (state.projects[i].id === id) return state.projects[i];
  }
  return null;
}

function cardsFor(boardId, columnKind) {
  if (!state) return [];
  return state.cards.filter(function (c) {
    if (c.boardId !== boardId || c.columnId !== columnKind || c.archived) return false;
    if (state.projectFilter && c.projectId !== state.projectFilter) return false;
    // The next-step filter (issue #119): "mine" keeps the
    // cards whose step is the person's; a key's id keeps that
    // key's cards; no one ("none") is not a filter entry — the
    // row offers Everyone, Mine and one entry per key.
    if (state.stepFilter === "mine" && stepOfCard(c).holder !== "owner") return false;
    if (state.stepFilter && state.stepFilter !== "mine") {
      var step = stepOfCard(c);
      if (step.holder !== "agent" || step.keyId !== state.stepFilter) return false;
    }
    return true;
  });
}

function findCard(id) {
  if (!state) return null;
  // A place built before the real id arrived can still name the card
  // by its temporary id — the open editor's Move buttons are one:
  // they were wired when the editor opened, and a new card's create
  // can land while the editor sits open. Translate the name through
  // the alias table, as every request body already does, so the card
  // is found by either name.
  var wanted = realId(id);
  for (var i = 0; i < state.cards.length; i++) {
    if (state.cards[i].id === wanted) return state.cards[i];
  }
  return null;
}

// Takes a fresh state from the API and keeps the view on a board and
// column that still exist.
// --- Per-board view memory, on this device ---
//
// A board is left the way it was left: its project filter and
// its column in view ride in the device settings, keyed by the
// board. The save happens as the board paints; the restore
// happens whenever the person arrives on a board — a switch, a
// fresh load, or the fallback when the board on screen is
// deleted. A remembered filter naming a project that is gone,
// or that lives on another board, falls back to All projects,
// and a remembered column that is gone falls back to the
// board's first column. The same save also records the standing
// view — the board on screen and the schedule and overview as
// they stand — which the boot's first adoption restores (see
// adoptState).
function saveBoardView() {
  if (!state || !state.activeBoard) return;
  var settings = readDeviceSettings();
  if (!settings.boardViews || typeof settings.boardViews !== "object") settings.boardViews = {};
  settings.boardViews[state.activeBoard] = {
    filter: state.projectFilter || null,
    column: state.activeColumn || null
  };
  settings.standingView = {
    boardId: state.activeBoard,
    scheduleOpen: !!scheduleOpen,
    scheduleTag: scheduleTag,
    overviewOpen: !!overviewOpen
  };
  writeDeviceSettings(settings);
}

function applyBoardView(boardId) {
  var settings = readDeviceSettings();
  var views = settings.boardViews && typeof settings.boardViews === "object" ? settings.boardViews : {};
  var view = views[boardId] || {};
  var proj = view.filter ? findProject(view.filter) : null;
  state.projectFilter = proj && proj.boardId === boardId ? proj.id : null;
  var kinds = columnsOf(activeBoardObj()).map(function (c) { return c.kind; });
  state.activeColumn = kinds.indexOf(view.column) !== -1 ? view.column : (kinds[0] || "inbox");
}

// The standing view this device last recorded: the board the
// person was on, whether the schedule stood open and on which
// tag, and whether the overview stood open. Anything malformed
// reads as no memory at all, and the boot then falls back to the
// first board with both views closed, the way it always has.
function readStandingView() {
  var settings = readDeviceSettings();
  var view = settings.standingView;
  if (!view || typeof view !== "object") return null;
  return {
    boardId: typeof view.boardId === "string" ? view.boardId : null,
    scheduleOpen: !!view.scheduleOpen,
    scheduleTag: view.scheduleTag === "undated" ? "undated" : "dated",
    overviewOpen: !!view.overviewOpen
  };
}

function adoptState(fresh) {
  // A snapshot older than the version already on show is
  // refused: it was read before a change this browser has
  // since taken in, and adopting it would rewind the board —
  // and the open editor with it — to before that change
  // (issues #164, #165). Server versions only ever rise, so
  // the next fetch converges. A copy left open across a
  // server data reset reads the other way and needs a plain
  // reload, which is the standing remedy there.
  if (state && typeof fresh.version === "number" && fresh.version < shownVersion) return false;
  var firstLoad = state === null;
  var keepBoard = state ? state.activeBoard : null;
  var keepColumn = state ? state.activeColumn : null;
  var keepFilter = state ? state.projectFilter : null;
  // The next-step filter is the session's own, like the view:
  // a fresh state carries none, so the choice is handed over.
  var keepStepFilter = state ? state.stepFilter : null;
  state = fresh;
  state.stepFilter = keepStepFilter || null;
  if (typeof fresh.version === "number") shownVersion = fresh.version;
  if (firstLoad) {
    // A refresh returns to where the person stood: on the first
    // adoption of a page load the device settings name the board,
    // the schedule and the overview as they were left, and a
    // remembered board that still exists becomes the board in
    // view below. A remembered board that is gone falls back to
    // the first board, exactly as a first-ever load does. Later
    // adoptions in the same session keep the session's own view.
    var standing = readStandingView();
    if (standing) {
      scheduleOpen = standing.scheduleOpen;
      scheduleTag = standing.scheduleTag;
      // A restored schedule shows the tag it was left on: the
      // opening choice (issue #33) belongs to the button press,
      // never to a refresh.
      scheduleShownTag = standing.scheduleTag;
      overviewOpen = standing.overviewOpen;
      if (standing.boardId && findBoard(standing.boardId)) keepBoard = standing.boardId;
    }
  }
  if (!findBoard(keepBoard)) {
    state.activeBoard = state.boards.length ? state.boards[0].id : null;
  } else {
    state.activeBoard = keepBoard;
  }
  if (keepBoard !== state.activeBoard || firstLoad) {
    // Arriving on a board: a first load, or the board on screen
    // went away. The board stands as this device left it.
    applyBoardView(state.activeBoard);
  } else {
    state.projectFilter = keepFilter && findProject(keepFilter) ? keepFilter : null;
    var kinds = columnsOf(activeBoardObj()).map(function (c) { return c.kind; });
    state.activeColumn = kinds.indexOf(keepColumn) !== -1 ? keepColumn : (kinds[0] || "inbox");
  }
  adoptAccountThemeOnce();
  if (state.me) saveMirror();
  return true;
}

// --- The theme mirror in local storage ---

var MIRROR_KEY = "tasksparkle-mirror";

function readMirror() {
  try {
    var raw = localStorage.getItem(MIRROR_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch (e) { /* A broken mirror reads as empty. */ }
  return {};
}

function saveMirror() {
  try {
    var mirror = readMirror();
    // The mirror holds a copy of this device's theme and nothing
    // else (issue #58): an earlier shape also kept the signed-in
    // person's name here, where nothing ever read it and it
    // outlived the session on a shared browser. The name is
    // never written now, and a stale one left by that shape is
    // dropped the first time this runs.
    delete mirror.name;
    if (state) {
      mirror.theme = currentThemeMode();
    }
    localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch (e) {
    // Storage can be unavailable in some private modes. The app still works.
  }
}

// --- The API ---

function api(method, path, body) {
  var options = { method: method, headers: {} };
  if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return fetch(path, options).then(function (res) {
    if (!res.ok) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        var err = new Error(data.error || ("Request failed (" + res.status + ")"));
        err.status = res.status;
        // The whole answer rides along: a refusal from the
        // sign-in routes names the step-up it wants (data.stepUp),
        // and the guarded acts read it to ask for that proof.
        err.data = data;
        // A 401 from the board API means the sign-in has
        // lapsed or ended: the way forward is the sign-in
        // page, from any screen. A 401 from a sign-in route
        // (/api/auth/...) means something narrower — this
        // caller's sign-in cannot do that act (the transition
        // door's caller holds no account) — and the caller's
        // own note says why, so it never navigates (issue
        // #110: the navigation read as a click doing nothing).
        if (res.status === 401 && path.indexOf("/api/auth/") !== 0) {
          window.location.href = "/login";
        }
        throw err;
      });
    }
    // Only a successful write clears the save banner (issue
    // #137): a read that lands after a failed save — the state
    // reload saveOrReload runs — is proof the connection
    // works, not that the save did, and clearing the banner
    // there hid the failure a moment after it was shown.
    if (method !== "GET") hideApiError();
    return res.json().catch(function () { return {}; });
  });
}

function showApiError() {
  var el = document.getElementById("api-error");
  if (!el) return;
  el.textContent = "Could not save. Check your connection and reload.";
  el.hidden = false;
}

function hideApiError() {
  var el = document.getElementById("api-error");
  if (el) el.hidden = true;
}

// Runs a saving call. On failure the error line shows and the state is
// fetched again, so the screen falls back to what the server holds.
function saveOrReload(promise) {
  return promise.catch(function (err) {
    showApiError();
    reloadState();
    throw err;
  });
}

// Every change goes through one queue, in the order it was made. The
// server reads a card, works out the new row and writes it back, so
// two changes in flight at once are both worked out against the same
// starting row and the later write quietly undoes the earlier one (a
// column move lost to a board move, both sent within a second). One
// at a time, each change is worked out against the row the last
// change left. A queued step builds its request when it runs, not
// when it is queued, so it sends the ids and values current at that
// moment: a label or board made a moment earlier carries its real id
// by then, never the temporary one it was painted with.
//
// The follow-up a step needs (swapping a temporary id for the real
// one, and pointing everything that used the temporary id at the
// real one) runs inside the step, before the next step starts. It
// cannot ride along in a .then on the returned promise instead: that
// promise resolves after the chain has already moved on, so the next
// step would build its request with the temporary id still in place,
// and the server would rightly refuse it.
var writeChain = Promise.resolve();
function queueWrite(step, followUp) {
  writesInFlight++;
  var run = writeChain.then(function () {
    return Promise.resolve()
      .then(step)
      .then(function (res) {
        // A write's answer carries the version it brought
        // about, and the board is showing that change the
        // moment the write lands, so the version on show
        // moves with it. Without this the number understates
        // the board, and a state fetched before the write
        // but delivered after it reads as current and
        // rewinds the board (issues #164, #165).
        if (res && typeof res.version === "number" && res.version > shownVersion) {
          shownVersion = res.version;
        }
        if (followUp) followUp(res);
        return res;
      });
  });
  writeChain = run.then(function () { /* keep the chain moving */ }, function () { /* keep the chain moving */ });
  run.then(writeSettled, writeSettled);
  return run;
}

// queueWrite with saveOrReload's failure handling.
function saveQueued(step, followUp) {
  return saveOrReload(queueWrite(step, followUp));
}

// Temporary ids and their real replacements. A thing painted a
// moment ago can still be named by its temporary id in places that
// were built before the real id arrived — the open editor's Label
// list is one: it was filled when the editor opened and is not
// rebuilt by the swap. Every followUp records the pairing here, and
// every request body translates through it, so a temporary id never
// reaches the server no matter which copy of it a body was built
// from.
var idAliases = {};
function realId(id) {
  return (id && idAliases[id]) || id;
}

function reloadState() {
  return api("GET", "/api/state").then(function (fresh) {
    adoptState(fresh);
    // A terms change that landed while this tab stood open
    // gates the boards the same way it gates a fresh load.
    if (fresh.termsUpdate) { showTermsGate(fresh.termsUpdate); return; }
    render();
    applyTheme();
    var backdrop = document.getElementById("settings-backdrop");
    if (backdrop && !backdrop.hidden) renderSettings();
  }).catch(function () {
    showApiError();
  });
}

// --- Live updates ---
//
// The server holds one version number per person and raises it on
// every change, whoever made it: the person on another device, or
// their agent through the API. The state carries the number, kept
// here as shownVersion — the version this browser is showing. A
// socket to /api/push brings each new number the moment its change
// lands. A number higher than shownVersion means this board is
// behind: the state is fetched again and the board repaints.
//
// The repaint waits until this browser's own write queue is idle
// and no drag is in flight, so it never lands in the middle of the
// person's own work. An open editor is settled field by field
// against its session (see the editor session notes): fields the
// person has not touched follow the fresh state, fields they are
// working on keep their copy, and typing survives. If the card in
// the editor is gone from the fresh state — deleted, or archived
// from somewhere else — the editor closes with a plain note.
//
// The socket reconnects on its own when it drops, checking the
// build file as it opens so anything missed while it was down
// is caught up. The same check runs when the tab comes back
// into view and on a slow interval, so even a socket that died
// silently cannot leave a stale board behind.

var shownVersion = 0;
var pushSocket = null;
var pushReconnectMs = 1000;
var pushRefreshWanted = false;
var pushRefreshRunning = false;
var pushStarted = false;
var writesInFlight = 0;
var pushNoteTimer = null;

// A queued write settled, one way or the other. When the last one
// lands, a refresh a push asked for can go ahead.
function writeSettled() {
  writesInFlight = Math.max(0, writesInFlight - 1);
  if (writesInFlight === 0) applyPushRefresh();
}

function startPush() {
  if (pushStarted) return;
  pushStarted = true;
  connectPush();
  setInterval(checkRemoteVersion, 60000);
}

function connectPush() {
  if (pushSocket) return;
  var scheme = window.location.protocol === "https:" ? "wss://" : "ws://";
  var socket;
  try {
    socket = new WebSocket(scheme + window.location.host + "/api/push");
  } catch (e) {
    planPushReconnect();
    return;
  }
  pushSocket = socket;
  socket.addEventListener("open", function () {
    pushReconnectMs = 1000;
    checkRemoteVersion();
  });
  socket.addEventListener("message", function (event) {
    var number = parseInt(event.data, 10);
    if (!isNaN(number) && number > shownVersion) {
      pushRefreshWanted = true;
      applyPushRefresh();
    }
  });
  socket.addEventListener("close", function () {
    if (pushSocket === socket) pushSocket = null;
    planPushReconnect();
  });
  socket.addEventListener("error", function () {
    try { socket.close(); } catch (e) { /* the close handler plans the reconnect */ }
  });
}

function planPushReconnect() {
  var wait = pushReconnectMs;
  pushReconnectMs = Math.min(pushReconnectMs * 2, 30000);
  setTimeout(connectPush, wait);
}

// Reads the static build file for the stamp as it stands, and
// queues a refresh when a number the answer carries is ahead of
// the one on show. The check used to ask the Worker's version
// route every minute from every open tab — 1,440 Worker
// requests a day a tab, idle or not — so it reads a static file
// instead (issue #10); the socket carries the live numbers, and
// this check is their backstop and the stamp's. A moved build
// stamp never reloads the app under the person (Site and Email
// Standards, Part 8): it raises the standing Updated notice, and
// the person presses Refresh now when they are ready (issue
// #67). A hidden tab asks nothing: the check pauses while the
// tab is hidden, and the tab's return asks again. Quiet on
// failure: the socket, the next check or the next push catches
// up.
function showUpdateNote() {
  var note = document.getElementById("update-note");
  if (note) note.hidden = false;
}

function checkRemoteVersion() {
  if (document.hidden) return;
  fetch("/build.json", { cache: "no-store" }).then(function (res) {
    if (!res.ok) throw new Error("build " + res.status);
    return res.json();
  }).then(function (data) {
    if (serverBuildMoved(data)) {
      showUpdateNote();
      return;
    }
    if (data && typeof data.version === "number" && data.version > shownVersion) {
      pushRefreshWanted = true;
      applyPushRefresh();
    }
  }).catch(function () { /* a later check catches up */ });
}

// Fetches the state and repaints, when a push or a check says this
// board is behind and nothing of the person's own is in flight.
function applyPushRefresh() {
  if (!pushRefreshWanted || pushRefreshRunning) return;
  if (writesInFlight > 0 || dragId) return;
  pushRefreshWanted = false;
  pushRefreshRunning = true;
  fetch("/api/state").then(function (res) {
    if (!res.ok) throw new Error("state " + res.status);
    return res.json();
  }).then(function (fresh) {
    pushRefreshRunning = false;
    if (adoptRemoteState(fresh) === false) {
      // The snapshot was older than the state on show and
      // was refused: fetch again, so the board still catches
      // up to the change that asked for this refresh.
      pushRefreshWanted = true;
    }
    if (pushRefreshWanted) applyPushRefresh();
  }).catch(function () {
    pushRefreshRunning = false;
    // Stay marked behind: the next push, check or tab return retries.
    pushRefreshWanted = true;
  });
}

// Takes a state fetched because someone else changed something.
// Cards that exist only here — a card being written in the open
// editor, not yet on the server — ride across the swap: they are
// not the server's to drop. The editor is never repainted; if the
// card it holds is gone from the fresh state, the editor closes
// with a note instead.
function adoptRemoteState(fresh) {
  var localOnly = [];
  var editingGone = false;
  if (state) {
    state.cards.forEach(function (card) {
      if (isTempId(card.id)) localOnly.push(card);
    });
  }
  var personSnapshot = null;
  var personStep = null;
  if (editingId && !isTempId(editingId)) {
    // Archived counts as gone for the editor's card: the state
    // carries archived cards now, flagged, but a card archived
    // from somewhere else is no longer on the board to edit.
    editingGone = !(fresh.cards || []).some(function (card) { return card.id === editingId && !card.archived; });
    if (!editingGone && editorSession && editorSession.cardId === editingId) {
      // The person's uncommitted values live in the controls and
      // the card about to be swapped out. Take them now, so the
      // session can settle the fresh card against them.
      var sessionCard = findCard(editingId);
      if (sessionCard) {
        personSnapshot = editorPersonValues(sessionCard);
        // A hand-over of this card is still in flight: the
        // step on the local card is the person's own paint,
        // newer than anything a snapshot read before the
        // hand-over landed can carry. It rides across the
        // swap the way the temp cards do (issue #164).
        if (editorStepInFlight > 0 && sessionCard.step) {
          personStep = Object.assign({}, sessionCard.step);
        }
      }
    }
  }
  if (adoptState(fresh) === false) return false;
  if (localOnly.length) state.cards = localOnly.concat(state.cards);
  if (personStep) {
    var stepCard = findCard(editingId);
    if (stepCard) stepCard.step = personStep;
  }
  render();
  applyTheme();
  // An open Settings follows the fresh state too, the way a
  // reload leaves it: a key revoked from the API side must stop
  // reading as ready on a panel that happens to be standing open.
  var settingsBackdrop = document.getElementById("settings-backdrop");
  if (settingsBackdrop && !settingsBackdrop.hidden) renderSettings();
  if (editingGone) {
    closeEditor();
    showPushNote("The card you were editing is gone, so the editor closed.");
    return;
  }
  if (personSnapshot) {
    var freshCard = findCard(editingId);
    if (freshCard) syncEditorSession(freshCard, personSnapshot);
  }
  return true;
}

function showPushNote(text) {
  var el = document.getElementById("push-note");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (pushNoteTimer) clearTimeout(pushNoteTimer);
  pushNoteTimer = setTimeout(function () { el.hidden = true; }, 9000);
}

// --- Theme. Three modes: system, light and dark, held on this
// device in the device settings, the way the display mode is. What
// paints is one resolved theme, light or dark, on <html> as
// data-theme. System resolves through the device setting and
// follows it live. ---

var THEME_MODES = ["system", "light", "dark"];
var THEME_NAMES = { system: "Default", light: "Light", dark: "Dark" };
var THEME_ICONS = {
  system: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>'
};

// The small list icon a card's face shows beside its checklist
// count, and the editor's step rows echo.
var CHECKLIST_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.2 5 7.7 8 4.7"/><path d="M11 6.5h9.5"/><path d="M3.5 13.2 5 14.7 8 11.7"/><path d="M11 13.5h9.5"/><path d="M11 20.5h9.5"/><path d="M3.8 20.5h.4"/></svg>';

// The small chain icon a card's face shows beside its link count.
var LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// The small speech bubble a card's face shows beside its comment
// count, in the same stroke family as the checklist and link icons.
var COMMENT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

// The one marker a flagged card wears: a small flag, drawn in the
// same stroke family as the checklist and link icons and coloured
// warm by the .important-flag rule. Unflagged cards show nothing.
var FLAG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>';

// The grip every card carries in its top corner: six dots in two
// columns of three. It is the one place a touch can pick a card up
// from, so a touch anywhere else on the card still scrolls or
// pages the column. A mouse can pick a card up from anywhere.
var GRIP_ICON = '<svg viewBox="0 0 10 16" aria-hidden="true" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.7"/><circle cx="7.5" cy="2.5" r="1.7"/><circle cx="2.5" cy="8" r="1.7"/><circle cx="7.5" cy="8" r="1.7"/><circle cx="2.5" cy="13.5" r="1.7"/><circle cx="7.5" cy="13.5" r="1.7"/></svg>';

function themeModeValid(mode) {
  return mode === "system" || mode === "light" || mode === "dark";
}

// The named looks. A look is a palette and a pair of fonts
// (styles.css carries one light block and one dark block per
// look); the mode — System, Light or Dark — composes with every
// look, and the header button keeps stepping the mode inside
// whichever look stands. Look and mode are both per device: the
// look sits in the device settings beside the display mode.
var LOOKS = ["standard", "comic", "console", "pretty",
  "artistic", "sunset", "forest", "midnight"];

function lookValid(look) {
  return LOOKS.indexOf(look) !== -1;
}

function currentLook() {
  var settings = readDeviceSettings();
  return lookValid(settings.look) ? settings.look : "standard";
}

function setLook(look) {
  if (!lookValid(look)) return;
  var settings = readDeviceSettings();
  settings.look = look;
  writeDeviceSettings(settings);
  applyTheme();
}

function currentThemeMode() {
  var settings = readDeviceSettings();
  if (themeModeValid(settings.theme)) return settings.theme;
  var mirror = readMirror();
  return themeModeValid(mirror.theme) ? mirror.theme : "system";
}

// The theme used to live in the account, so the account's stored
// mode seeds a device that has never chosen — exactly once, when
// its first state lands (see adoptState). After that the device's
// word is final: a theme change never writes to the server, never
// bumps the state version and never reaches another device.
function adoptAccountThemeOnce() {
  if (!state) return;
  var settings = readDeviceSettings();
  if (themeModeValid(settings.theme)) return;
  if (!themeModeValid(state.theme)) return;
  settings.theme = state.theme;
  writeDeviceSettings(settings);
}

function resolvedTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme() {
  var mode = currentThemeMode();
  document.documentElement.setAttribute("data-theme", resolvedTheme(mode));
  document.documentElement.setAttribute("data-theme-mode", mode);
  document.documentElement.setAttribute("data-look", currentLook());
  document.querySelectorAll(".look-btn").forEach(function (btn) {
    var on = btn.getAttribute("data-look") === currentLook();
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  // The toggle's face names the mode a click brings, the way
  // the display button's face names its tap's step (issue #48):
  // the glyph and the label are the next mode's, not the
  // standing one's.
  var nextMode = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
  var label = "Theme: " + THEME_NAMES[nextMode];
  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.innerHTML = THEME_ICONS[nextMode];
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }
  document.querySelectorAll(".theme-mode-btn").forEach(function (btn) {
    var on = btn.getAttribute("data-theme-mode") === mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  // Card chips carry their label colours as inline styles, so a theme
  // change repaints the board and any open Settings previews too.
  if (state) {
    render();
    var backdrop = document.getElementById("settings-backdrop");
    if (backdrop && !backdrop.hidden) renderSettings();
  }
}

function setThemeMode(mode) {
  if (!themeModeValid(mode)) return;
  var settings = readDeviceSettings();
  settings.theme = mode;
  writeDeviceSettings(settings);
  // The mirror follows the device, so the next load's first paint
  // already wears this device's theme.
  saveMirror();
  applyTheme();
}

function formatDue(iso) {
  if (!iso) return "";
  var parts = iso.split("-");
  if (parts.length !== 3) return iso;
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  return "Due " + months[m - 1] + " " + d;
}

// Today where the person is, as a YYYY-MM-DD string, so it can
// stand beside a card's due date directly.
function localToday() {
  var now = new Date();
  var month = String(now.getMonth() + 1).padStart(2, "0");
  var day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

// A card is late when its due day is before today. A card due
// today is not late.
function isLateCard(card) {
  return !!card.due && card.due < localToday();
}

// The words the card delete dialog carries: the card is named,
// where it stands is named — on the board, or archived — what
// goes with it is named (its checklist steps, its links and its
// comments), and the deletion is named as permanent. The
// editor's Delete and the Archived list's Delete open the one
// dialog (issue #97), so the two ask in the same words.
function cardDeleteNote(card) {
  var name = card.title && card.title.trim() ? card.title.trim() : "Untitled card";
  var steps = card.steps ? card.steps.length : 0;
  var links = card.links ? card.links.length : 0;
  var comments = card.comments ? card.comments.length : 0;
  var text = "Delete “" + name + "”? ";
  text += card.archived ? "It is archived. " : "It is on the board. ";
  if (steps || links || comments) {
    var bits = [];
    if (steps) bits.push(steps + (steps === 1 ? " checklist step" : " checklist steps"));
    if (links) bits.push(links + (links === 1 ? " link" : " links"));
    if (comments) bits.push(comments + (comments === 1 ? " comment" : " comments"));
    var verb = steps + links + comments === 1 ? " goes" : " go";
    text += "Its " + bits.join(" and ") + verb + " with it. ";
  }
  return text + "It cannot be brought back.";
}

function formatMadeDate(iso) {
  if (!iso) return "";
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var parts = String(iso).slice(0, 10).split("-");
  if (parts.length !== 3) return "";
  return months[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10) + ", " + parts[0];
}

// A comment's time, in the words the editor shows under it: the
// made date, plus the time of day in the reader's own clock. A
// stamp that does not parse shows the date alone rather than a
// broken time.
function formatCommentTime(iso) {
  var date = formatMadeDate(iso);
  if (!date) return "";
  var when = new Date(iso);
  if (isNaN(when.getTime())) return date;
  var hours = when.getHours();
  var minutes = String(when.getMinutes()).padStart(2, "0");
  var meridiem = hours >= 12 ? "PM" : "AM";
  var hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return date + ", " + hour12 + ":" + minutes + " " + meridiem;
}

// --- Rendering ---

// The phone chip strip's sideways scroll, handed through one
// render (issue #34). Every render rebuilds the strip's run as a
// new element, and a new element starts at scroll position zero,
// so a chip tap — which pages by way of a render — used to throw
// the strip back to its start. The tap's handler records the
// run's position here, and the render that rebuilds the run puts
// it back and spends the record. Nothing else sets it, so every
// other render rebuilds the strip exactly as before.
var stepChipsScrollToKeep = null;

// The chip strip's scrollbar line fades (issue #36): the class
// and the countdown live here, outside the strip's element,
// because every render rebuilds that element. Use is a scroll
// of the strip, a press on it or a wheel over it. Each use puts
// the chips-in-use class on the run and restarts a one-second
// countdown; when the countdown runs out the class comes off
// the run that then stands in the page, and styles.css eases
// the line away. A render inside the countdown puts the class
// on the new run, the way it puts the scroll position back.
var chipsInUseTimer = null;

// When the render last put a kept scroll position back on the
// new run. That write fires a scroll event of its own, and the
// echo is not use: the strip's scroll handler ignores a scroll
// that lands within a breath of the restore.
var chipsRestoredAt = 0;

function chipsInUse(run) {
  run.classList.add("chips-in-use");
  if (chipsInUseTimer !== null) clearTimeout(chipsInUseTimer);
  chipsInUseTimer = setTimeout(function () {
    chipsInUseTimer = null;
    var current = document.querySelector(".step-chips");
    if (current) current.classList.remove("chips-in-use");
  }, 1000);
}

function render() {
  if (!state) return;
  // The header's Account button carries the person glyph in
  // its markup (issue #90): the name stands only in its label,
  // refreshed here, with the boards, so a rename renames the
  // label with everything else. No name, no button: an empty
  // slot never stands in the row.
  var accountPlace = document.getElementById("account-open");
  if (accountPlace) {
    accountPlace.hidden = !(state.me && state.me.name);
    if (state.me && state.me.name) {
      accountPlace.setAttribute("aria-label", "Account — " + state.me.name);
      accountPlace.setAttribute("title", "Account — " + state.me.name);
    }
  }
  var board = activeBoardObj();
  var columns = columnsOf(board);

  // Board tabs come from the signed-in person's boards. Each tab
  // carries the board's icon and its name; this device's display
  // mode decides whether both show, the name alone or the icon
  // alone (styles.css), so the aria-label always carries the name.
  var switcher = document.getElementById("board-switcher");
  switcher.innerHTML = "";
  state.boards.forEach(function (b) {
    var tab = document.createElement("button");
    tab.type = "button";
    tab.className = "board-tab" + (b.id === state.activeBoard ? " active" : "");
    tab.setAttribute("data-board", b.id);
    tab.setAttribute("aria-pressed", b.id === state.activeBoard ? "true" : "false");
    tab.setAttribute("aria-label", b.name);
    tab.title = b.name;
    var tabIcon = document.createElement("span");
    tabIcon.className = "board-tab-icon";
    tabIcon.setAttribute("data-role", "board-tab-icon");
    tabIcon.textContent = boardIcon(b);
    tab.appendChild(tabIcon);
    var tabName = document.createElement("span");
    tabName.className = "board-tab-name";
    tabName.textContent = b.name;
    tab.appendChild(tabName);
    switcher.appendChild(tab);
  });

  // Project filter row
  var filterWrap = document.getElementById("project-filter");
  filterWrap.innerHTML = "";
  var allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "filter-btn" + (!state.projectFilter ? " active" : "");
  allBtn.textContent = "All projects";
  allBtn.setAttribute("aria-pressed", !state.projectFilter ? "true" : "false");
  allBtn.addEventListener("click", function () {
    state.projectFilter = null;
    render();
  });
  filterWrap.appendChild(allBtn);
  projectsFor(state.activeBoard).forEach(function (proj) {
    var btn = document.createElement("button");
    btn.type = "button";
    var on = state.projectFilter === proj.id;
    btn.className = "filter-btn" + (on ? " active" : "");
    btn.setAttribute("data-project", proj.id);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    if (proj.icon) btn.classList.add("has-icon");
    if (proj.icon) {
      var pIcon = document.createElement("span");
      pIcon.className = "project-icon";
      pIcon.setAttribute("data-role", "project-icon");
      pIcon.textContent = proj.icon;
      btn.appendChild(pIcon);
    }
    var name = document.createElement("span");
    name.className = "filter-name";
    name.textContent = proj.name;
    btn.appendChild(name);
    btn.addEventListener("click", function (ev) {
      // The release of a fired press-and-hold lands here; it
      // belongs to the press, not to the filter.
      if (pressClickSwallowed("project", proj.id)) return;
      // The second click of a double-click opens the rename
      // editor on the pill, read off the click's own count the
      // way the board switcher reads it. The first click of one
      // never applies the filter: a mouse or pen click waits out
      // the double-click window (see deferPressApply), and the
      // second click cancels the wait and opens the editor.
      if (ev.detail === 2) {
        cancelPressApply("project:" + proj.id);
        openPressEditor("project", proj.id, btn);
        return;
      }
      var applyFilter = function () {
        state.projectFilter = proj.id;
        render();
      };
      if (clickAppliesAtOnce(ev)) applyFilter();
      else deferPressApply("project:" + proj.id, applyFilter);
    });
    filterWrap.appendChild(btn);
  });
  var addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "filter-btn filter-add";
  addBtn.id = "project-add-open";
  addBtn.textContent = "+ Project";
  addBtn.addEventListener("click", function () {
    document.getElementById("project-add-form").hidden = false;
    document.getElementById("project-name-input").focus();
  });
  filterWrap.appendChild(addBtn);

  // Next-step filter row (issue #119): Everyone, Mine, and one
  // entry per agent key, in the project filter's own pattern.
  // The row stands only while the owner holds a key — with no
  // keys there is nobody else's step to filter by. A filter
  // naming a key that is gone falls back to Everyone, the way
  // a remembered project filter falls back to All projects.
  var stepFilterWrap = document.getElementById("step-filter");
  if (stepFilterWrap) {
    stepFilterWrap.innerHTML = "";
    var ownerKeys = state.keys || [];
    if (state.stepFilter && state.stepFilter !== "mine" &&
        !ownerKeys.some(function (key) { return key.id === state.stepFilter; })) {
      state.stepFilter = null;
    }
    stepFilterWrap.hidden = ownerKeys.length === 0;
    if (ownerKeys.length) {
      var stepEntries = [{ value: null, name: "Everyone" }, { value: "mine", name: "Mine" }]
        .concat(ownerKeys.map(function (key) { return { value: key.id, name: key.name }; }));
      stepEntries.forEach(function (entry) {
        var btn = document.createElement("button");
        btn.type = "button";
        var on = (state.stepFilter || null) === entry.value;
        btn.className = "filter-btn" + (on ? " active" : "");
        btn.setAttribute("data-step-filter", entry.value === null ? "everyone" : entry.value);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        btn.textContent = entry.name;
        btn.addEventListener("click", function () {
          state.stepFilter = entry.value;
          render();
        });
        stepFilterWrap.appendChild(btn);
      });
    }
  }

  // Column stepper (phone): the name chips in their own scrolling
  // run, and nothing else — the See all columns and Schedule
  // buttons live in the board row above, pinned at its right
  // margin. While the schedule stands open the chips stand down
  // with the columns they steer, and the stepper hides away.
  var stepper = document.getElementById("column-stepper");
  stepper.innerHTML = "";
  stepper.hidden = scheduleOpen;
  var chips = document.createElement("div");
  chips.className = "step-chips";
  columns.forEach(function (col) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "step-btn" + (col.kind === state.activeColumn ? " active" : "");
    btn.setAttribute("data-column", col.kind);
    btn.setAttribute("aria-label", col.name);
    var sIcon = document.createElement("span");
    sIcon.className = "step-icon";
    sIcon.setAttribute("data-role", "column-icon");
    sIcon.textContent = columnIcon(col);
    btn.appendChild(sIcon);
    var name = document.createElement("span");
    name.className = "step-name";
    name.textContent = col.name;
    btn.appendChild(name);
    btn.addEventListener("click", function () {
      // The render below rebuilds the chips run as a new element,
      // which starts unscrolled: hand this run's sideways scroll
      // through the render, so the strip stands where it stood
      // and only the column changes (issue #34).
      if (btn.parentElement) stepChipsScrollToKeep = btn.parentElement.scrollLeft;
      state.activeColumn = col.kind;
      // A chip tapped while the overview stands is a choice, the
      // way a strip is: it lands inside that column.
      overviewOpen = false;
      render();
    });
    chips.appendChild(btn);
  });
  if (!scheduleOpen) {
    stepper.appendChild(chips);
    // A chip tap handed its run's scroll through this render
    // (issue #34): put the position back on the new run now that
    // it stands in the page with its chips in it, and spend the
    // record so no later render inherits it.
    if (stepChipsScrollToKeep !== null) {
      chips.scrollLeft = stepChipsScrollToKeep;
      stepChipsScrollToKeep = null;
      chipsRestoredAt = Date.now();
    }
    // The strip's scrollbar fades (issue #36): while the
    // in-use countdown still runs, the new run wears the class
    // from the start, so the line never blinks out mid-scroll
    // just because a render rebuilt the run.
    if (chipsInUseTimer !== null) chips.classList.add("chips-in-use");
    chips.addEventListener("scroll", function () {
      if (Date.now() - chipsRestoredAt < 100) return;
      chipsInUse(chips);
    });
    chips.addEventListener("pointerdown", function () { chipsInUse(chips); });
    chips.addEventListener("wheel", function () { chipsInUse(chips); }, { passive: true });
  }

  // Columns and cards
  var wrap = document.getElementById("columns");
  wrap.innerHTML = "";
  columns.forEach(function (col) {
    var cards = cardsFor(state.activeBoard, col.kind);

    var section = document.createElement("section");
    section.className = "column" + (col.kind === state.activeColumn ? " active" : "");
    section.setAttribute("data-column", col.kind);

    var head = document.createElement("div");
    head.className = "column-head";
    var h = document.createElement("h2");
    h.setAttribute("aria-label", col.name);
    var hIcon = document.createElement("span");
    hIcon.className = "column-icon";
    hIcon.setAttribute("data-role", "column-icon");
    hIcon.textContent = columnIcon(col);
    h.appendChild(hIcon);
    var hName = document.createElement("span");
    hName.className = "column-name";
    hName.textContent = col.name;
    h.appendChild(hName);
    var countEl = document.createElement("span");
    countEl.className = "column-count";
    countEl.textContent = cards.length + (cards.length === 1 ? " card" : " cards");
    head.appendChild(h);
    head.appendChild(countEl);
    section.appendChild(head);

    var list = document.createElement("div");
    list.className = "card-list";

    if (cards.length === 0) {
      var empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "No cards here.";
      list.appendChild(empty);
    }

    cards.forEach(function (card) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "card";
      el.setAttribute("data-card", card.id);

      var grip = document.createElement("span");
      grip.className = "card-grip";
      grip.setAttribute("data-role", "card-grip");
      grip.setAttribute("aria-hidden", "true");
      grip.innerHTML = GRIP_ICON;
      el.appendChild(grip);

      var title = document.createElement("span");
      title.className = "card-title";
      title.textContent = card.title;
      el.appendChild(title);

      var project = findProject(card.projectId);
      var wornLabels = cardLabels(card);
      // The board's label paint (issue #95): the first label's
      // colour on the card itself, in the board's chosen mode.
      paintCardByLabel(el, board, wornLabels, "full");
      var cardSteps = card.steps || [];
      var cardStepsDone = 0;
      cardSteps.forEach(function (s) { if (s.done) cardStepsDone++; });
      var cardLinks = card.links || [];
      var cardComments = card.comments || [];
      if (wornLabels.length || card.due || project || cardSteps.length || cardLinks.length || cardComments.length || card.creatorKeyName || card.important || stepOfCard(card).holder === "agent") {
        var meta = document.createElement("span");
        meta.className = "card-meta";
        if (card.important) {
          var flag = document.createElement("span");
          flag.className = "important-flag";
          flag.setAttribute("data-important-flag", card.id);
          flag.setAttribute("title", "Important");
          flag.innerHTML = FLAG_ICON;
          meta.appendChild(flag);
        }
        wornLabels.forEach(function (wornLabel) {
          meta.appendChild(buildChip(wornLabel));
        });
        if (project) {
          var tag = document.createElement("span");
          tag.className = "project-tag";
          // A project is named by its word, with its icon beside
          // it when it has one; the word steps aside only in
          // Icons mode. (The coloured dot a project once wore is
          // gone — issue #94.)
          if (project.icon) {
            tag.classList.add("has-icon");
            var tagIcon = document.createElement("span");
            tagIcon.className = "project-icon";
            tagIcon.setAttribute("data-role", "project-icon");
            tagIcon.textContent = project.icon;
            tag.appendChild(tagIcon);
          }
          var pname = document.createElement("span");
          pname.className = "project-tag-name";
          pname.textContent = project.name;
          tag.appendChild(pname);
          meta.appendChild(tag);
        }
        if (card.due) {
          var due = document.createElement("span");
          due.className = "due";
          due.textContent = formatDue(card.due);
          meta.appendChild(due);
          if (isLateCard(card)) {
            var late = document.createElement("span");
            late.className = "late-tag";
            late.textContent = "Late";
            meta.appendChild(late);
          }
        }
        if (cardSteps.length) {
          var prog = document.createElement("span");
          prog.className = "checklist-progress" + (cardStepsDone === cardSteps.length ? " all-done" : "");
          prog.setAttribute("data-checklist-progress", card.id);
          prog.innerHTML = CHECKLIST_ICON;
          var progText = document.createElement("span");
          progText.textContent = cardStepsDone + "/" + cardSteps.length;
          prog.appendChild(progText);
          meta.appendChild(prog);
        }
        if (cardLinks.length) {
          var linkCount = document.createElement("span");
          linkCount.className = "link-count";
          linkCount.setAttribute("data-link-count", card.id);
          linkCount.innerHTML = LINK_ICON;
          var linkCountText = document.createElement("span");
          linkCountText.textContent = String(cardLinks.length);
          linkCount.appendChild(linkCountText);
          meta.appendChild(linkCount);
        }
        if (cardComments.length) {
          var commentCount = document.createElement("span");
          commentCount.className = "comment-count";
          commentCount.setAttribute("data-comment-count", card.id);
          commentCount.innerHTML = COMMENT_ICON;
          var commentCountText = document.createElement("span");
          commentCountText.textContent = String(cardComments.length);
          commentCount.appendChild(commentCountText);
          meta.appendChild(commentCount);
        }
        // The maker tag stands only when the step holder
        // is not the key that made the card (issue #123,
        // Derick's ruling): when the maker holds the step,
        // the step chip below names it, and the face wears
        // one pill instead of two carrying the same name.
        // The comparison is by key id, never by name —
        // names resolve live and two keys can share one.
        // The editor keeps both facts; only the face drops
        // the second pill.
        var faceStep = stepOfCard(card);
        var makerHoldsStep = faceStep.holder === "agent" &&
          !!faceStep.keyId && !!card.creatorKeyId && faceStep.keyId === card.creatorKeyId;
        if (card.creatorKeyName && !makerHoldsStep) {
          var creatorTag = buildCreatorTag(card.creatorKeyName);
          creatorTag.setAttribute("data-creator-tag", card.id);
          creatorTag.setAttribute("title", "Created by the " + card.creatorKeyName + " agent key");
          meta.appendChild(creatorTag);
        }
        if (stepOfCard(card).holder === "agent") {
          meta.appendChild(buildStepChip(card));
        }
        el.appendChild(meta);
      }

      el.addEventListener("click", function () {
        // The click a finished drag leaves behind is not an open.
        if (suppressCardClick) { suppressCardClick = false; return; }
        openEditor(card.id);
      });
      el.addEventListener("pointerdown", function (ev) { watchCardPointer(ev, card, el); });
      list.appendChild(el);
    });

    section.appendChild(list);

    // The column's own plus stands at its foot: a new card starts
    // in this column. The foot is outside the card list, so the
    // drag never mistakes the button for a landing place; it is
    // inside the section, so a drag passing over it still reads
    // this column as the one under the pointer.
    var foot = document.createElement("div");
    foot.className = "column-foot";
    var addHere = document.createElement("button");
    addHere.type = "button";
    addHere.className = "btn btn-primary column-add-btn";
    addHere.textContent = "+";
    addHere.setAttribute("data-add-to", col.kind);
    addHere.setAttribute("aria-label", "Add a card to " + col.name);
    addHere.title = "Add a card to " + col.name;
    addHere.addEventListener("click", function () {
      // The click a finished swipe leaves behind is not an add.
      // The swipe's pointerup swallows it for that turn (see
      // swallowAddClick), the way a finished drag swallows its
      // own click on a card.
      if (suppressAddClick) { suppressAddClick = false; return; }
      if (state) openNewCard(col.kind);
    });
    foot.appendChild(addHere);
    section.appendChild(foot);

    wrap.appendChild(section);
  });

  // The phone's overview stands in place of the columns while it
  // is open. It never stands on a wide screen: the button that
  // opens it shows only at phone width, and the check here
  // keeps a board from losing its columns if the window grows
  // past phone width with the overview up.
  var showOverview = overviewOpen && isPhoneLayout() && !scheduleOpen;
  document.getElementById("board-ui").classList.toggle("show-overview", showOverview);
  var overviewEl = document.getElementById("board-overview");
  overviewEl.hidden = !showOverview;
  if (showOverview) renderOverview(overviewEl, columns);

  // The schedule swaps in for the columns and the Archived list:
  // while it stands open both stand down, and the Schedule icon
  // wears its pressed state. The See all columns icon wears its
  // own state the same way: filled while the overview stands, its
  // label reading as the way back, and hidden altogether while
  // the schedule stands, since there are no columns to zoom out to.
  document.getElementById("columns").hidden = scheduleOpen;
  renderArchived(columns);
  if (scheduleOpen) document.getElementById("archived-section").hidden = true;
  var schedHead = document.getElementById("schedule-toggle");
  if (schedHead) {
    schedHead.classList.toggle("active", scheduleOpen);
    schedHead.setAttribute("aria-pressed", scheduleOpen ? "true" : "false");
  }
  var zoomHead = document.getElementById("overview-toggle");
  if (zoomHead) {
    var zoomLabel = overviewOpen ? "Back to one column" : "See all columns";
    zoomHead.classList.toggle("active", overviewOpen);
    zoomHead.setAttribute("aria-pressed", overviewOpen ? "true" : "false");
    zoomHead.setAttribute("aria-label", zoomLabel);
    zoomHead.setAttribute("title", zoomLabel);
    zoomHead.hidden = scheduleOpen;
  }
  renderSchedule(board, columns);
  renderSearch();
  saveBoardView();
}

// --- The schedule ------------------------------------------------
// The schedule lists the board in view under its project filter —
// the same scope the columns show — as one scrolling page. The
// Dated tag lists dated cards soonest first under date headings:
// late cards first, then Today, Tomorrow, then each later date.
// The Undated tag gathers the board's undated cards by column.
// Every row names its column (in the undated list the group heading
// does), and every row opens the card editor.

var SCHEDULE_WEEKDAYS = ["Sun", "Mon", "Tues", "Wed", "Thurs", "Fri", "Sat"];
var SCHEDULE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A YYYY-MM-DD day n days from today, in local time like
// localToday().
function isoPlusDays(n) {
  var d = new Date();
  d.setDate(d.getDate() + n);
  var p = function (v) { return String(v).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// "Tues May 16 (Today)": short weekday, short month and day, the
// year only when it is not this year, and (Today) or (Tomorrow)
// after the date when either applies.
function scheduleDateLabel(iso) {
  var parts = iso.split("-");
  var year = Number(parts[0]);
  var dt = new Date(year, Number(parts[1]) - 1, Number(parts[2]));
  var label = SCHEDULE_WEEKDAYS[dt.getDay()] + " " +
    SCHEDULE_MONTHS[Number(parts[1]) - 1] + " " + Number(parts[2]);
  if (year !== new Date().getFullYear()) label += " " + year;
  if (iso === localToday()) label += " (Today)";
  else if (iso === isoPlusDays(1)) label += " (Tomorrow)";
  return label;
}

// One schedule row: the card's title, its column's name and, for
// a late card, the Late tag the card face wears. Tapping the row
// opens the card editor, like tapping the card itself.
function scheduleRow(card, columnName, showDue) {
  var row = document.createElement("button");
  row.type = "button";
  row.className = "schedule-row";
  var title = document.createElement("span");
  title.className = "schedule-row-title";
  title.textContent = card.title;
  row.appendChild(title);
  if (card.important) {
    var flag = document.createElement("span");
    flag.className = "card-flag";
    flag.textContent = "⚑";
    flag.title = "Important";
    row.appendChild(flag);
  }
  if (showDue && card.due) {
    var due = document.createElement("span");
    due.className = "schedule-row-meta";
    due.textContent = formatDue(card.due);
    row.appendChild(due);
  }
  var col = document.createElement("span");
  col.className = "schedule-row-meta";
  col.textContent = columnName;
  row.appendChild(col);
  if (isLateCard(card)) {
    var late = document.createElement("span");
    late.className = "late-tag";
    late.textContent = "Late";
    row.appendChild(late);
  }
  row.addEventListener("click", function () { openEditor(card.id); });
  return row;
}

// The cards the schedule lists, from either tag: the board in
// view's active cards, under its project filter when one stands.
// Archived cards are out — the schedule's own Dated list never
// shows one — so the Schedule button's opening choice (issue
// #33) counts dated cards in this same scope, and "in scope"
// keeps one meaning across the whole schedule.
function scheduleScopedCards() {
  var board = activeBoardObj();
  if (!state || !board) return [];
  return state.cards.filter(function (c) {
    return c.boardId === board.id && !c.archived &&
      (!state.projectFilter || c.projectId === state.projectFilter);
  });
}

function scheduleGroup(title) {
  var group = document.createElement("div");
  group.className = "schedule-group";
  var heading = document.createElement("h3");
  heading.className = "schedule-group-title";
  heading.textContent = title;
  group.appendChild(heading);
  return group;
}

function renderSchedule(board, columns) {
  var wrap = document.getElementById("schedule-view");
  if (!wrap) return;
  wrap.hidden = !scheduleOpen;
  if (!scheduleOpen || !board) return;
  wrap.innerHTML = "";

  var tags = document.createElement("div");
  tags.className = "schedule-tags";
  [["dated", "Dated"], ["undated", "Undated"]].forEach(function (pair) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "schedule-tag" + (scheduleShownTag === pair[0] ? " active" : "");
    btn.setAttribute("data-tag", pair[0]);
    btn.setAttribute("aria-pressed", scheduleShownTag === pair[0] ? "true" : "false");
    btn.textContent = pair[1];
    btn.addEventListener("click", function () {
      // A tag tapped by hand is the person's own choice: it is
      // what shows, and it is what the schedule remembers.
      scheduleTag = pair[0];
      scheduleShownTag = pair[0];
      render();
    });
    tags.appendChild(btn);
  });
  wrap.appendChild(tags);

  var columnName = {};
  var columnOrder = {};
  columns.forEach(function (col, i) {
    columnName[col.kind] = col.name;
    columnOrder[col.kind] = i;
  });
  var scoped = scheduleScopedCards();

  if (scheduleShownTag === "dated") {
    var dated = scoped.filter(function (c) { return !!c.due; });
    dated.sort(function (a, b) {
      if (a.due !== b.due) return a.due < b.due ? -1 : 1;
      var byColumn = (columnOrder[a.columnId] || 0) - (columnOrder[b.columnId] || 0);
      return byColumn !== 0 ? byColumn : a.position - b.position;
    });
    if (!dated.length) {
      var noneDated = document.createElement("p");
      noneDated.className = "schedule-empty";
      noneDated.textContent = "No dated cards here.";
      wrap.appendChild(noneDated);
      return;
    }
    var today = localToday();
    var groups = [];
    var lateCards = dated.filter(function (c) { return c.due < today; });
    if (lateCards.length) groups.push({ title: "Late", cards: lateCards, showDue: true });
    var byDate = {};
    dated.forEach(function (c) {
      if (c.due < today) return;
      if (!byDate[c.due]) { byDate[c.due] = []; groups.push({ title: scheduleDateLabel(c.due), cards: byDate[c.due], showDue: false }); }
      byDate[c.due].push(c);
    });
    groups.forEach(function (g) {
      var group = scheduleGroup(g.title);
      g.cards.forEach(function (c) { group.appendChild(scheduleRow(c, columnName[c.columnId], g.showDue)); });
      wrap.appendChild(group);
    });
    return;
  }

  var undated = scoped.filter(function (c) { return !c.due; });
  if (!undated.length) {
    var noneUndated = document.createElement("p");
    noneUndated.className = "schedule-empty";
    noneUndated.textContent = "No undated cards here.";
    wrap.appendChild(noneUndated);
    return;
  }
  columns.forEach(function (col) {
    var inCol = undated.filter(function (c) { return c.columnId === col.kind; });
    if (!inCol.length) return;
    inCol.sort(function (a, b) { return a.position - b.position; });
    var group = scheduleGroup(col.name);
    inCol.forEach(function (c) { group.appendChild(scheduleRow(c, col.name, false)); });
    wrap.appendChild(group);
  });
}

// The schedule's back-to-top button: it stands at the lower right
// once the page has scrolled, and only while the schedule stands
// open — the list is the long page it serves.
function paintBackToTop() {
  var btn = document.getElementById("back-to-top");
  if (!btn) return;
  btn.hidden = !(scheduleOpen && window.scrollY > 300);
}

// --- Search ------------------------------------------------------
// Search stands over every board. The header's search button
// slides a bar in under the top row; typed words match card
// titles, notes and checklist steps, and the Filters button
// expands a board dropdown (All boards first), a project and a
// label dropdown that follow the board dropdown's scope, and
// bubbles including Archived — off by default, and tapped it
// adds the archived cards to the pool beside the active ones.
// Results render from state on every render, so a card archived
// or deleted leaves them at once, the same way push refreshes
// everything else. The search's own state lives here, outside
// the editor, so closing the editor on a result returns to the
// search exactly as it stood.

var searchOpen = false;
var searchClosing = false;
var searchFiltersOpen = false;
var searchText = "";
var searchBoardId = "";
var searchProjectId = "";
var searchLabelId = "";
var searchArchived = false;

function paintSearchToggle() {
  var btn = document.getElementById("search-toggle");
  if (!btn) return;
  btn.classList.toggle("active", searchOpen);
  btn.setAttribute("aria-pressed", searchOpen ? "true" : "false");
}

function toggleSearch() {
  if (searchOpen) { closeSearch(); return; }
  searchOpen = true;
  renderSearch();
  var input = document.getElementById("search-input");
  if (input) input.focus();
}

function closeSearch() {
  searchOpen = false;
  paintSearchToggle();
  var area = document.getElementById("search-area");
  if (!area || area.hidden) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    area.hidden = true;
    return;
  }
  // The bar slides back out before it hides; renders leave it
  // alone while the animation runs.
  searchClosing = true;
  area.classList.add("closing");
  setTimeout(function () {
    area.classList.remove("closing");
    area.hidden = true;
    searchClosing = false;
  }, 160);
}

function searchMatches(card) {
  // The Archived bubble adds the archived cards to the
  // results (issue #139): standing off, archived cards stay
  // out; standing on, they stand beside the live matches —
  // it widens the pool, it never swaps it.
  if (card.archived && !searchArchived) return false;
  if (searchBoardId && card.boardId !== searchBoardId) return false;
  if (searchProjectId && card.projectId !== searchProjectId) return false;
  if (searchLabelId && (card.labels || []).indexOf(searchLabelId) === -1) return false;
  var words = searchText.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  var haystack = [card.title || "", card.notes || ""];
  (card.steps || []).forEach(function (s) { haystack.push(s.text || ""); });
  var text = haystack.join("\n").toLowerCase();
  return words.every(function (w) { return text.indexOf(w) !== -1; });
}

function fillSearchSelect(sel, options, value) {
  if (!sel) return;
  sel.innerHTML = "";
  options.forEach(function (o) {
    var opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
  sel.value = value;
  if (sel.value !== value) sel.value = "";
}

function renderSearch() {
  var area = document.getElementById("search-area");
  if (!area) return;
  paintSearchToggle();
  if (searchClosing) return;
  area.hidden = !searchOpen;
  if (!searchOpen || !state) return;

  var input = document.getElementById("search-input");
  if (input && input.value !== searchText) input.value = searchText;

  fillSearchSelect(document.getElementById("search-board"),
    [{ value: "", label: "All boards" }].concat(state.boards.map(function (b) {
      return { value: b.id, label: b.name };
    })), searchBoardId);

  // The project and label dropdowns follow the board dropdown's
  // scope: one board's own, or every board's with the board named
  // beside each. A pick the new scope leaves behind is cleared.
  var scopeBoards = searchBoardId
    ? state.boards.filter(function (b) { return b.id === searchBoardId; })
    : state.boards;
  var projectOptions = [{ value: "", label: "All projects" }];
  var labelOptions = [{ value: "", label: "All labels" }];
  scopeBoards.forEach(function (b) {
    projectsFor(b.id).forEach(function (p) {
      projectOptions.push({ value: p.id, label: searchBoardId ? p.name : p.name + " (" + b.name + ")" });
    });
    labelsForBoard(b.id).forEach(function (l) {
      labelOptions.push({ value: l.id, label: searchBoardId ? l.name : l.name + " (" + b.name + ")" });
    });
  });
  if (searchProjectId && !projectOptions.some(function (o) { return o.value === searchProjectId; })) searchProjectId = "";
  if (searchLabelId && !labelOptions.some(function (o) { return o.value === searchLabelId; })) searchLabelId = "";
  fillSearchSelect(document.getElementById("search-project"), projectOptions, searchProjectId);
  fillSearchSelect(document.getElementById("search-label"), labelOptions, searchLabelId);

  var filters = document.getElementById("search-filters");
  if (filters) filters.hidden = !searchFiltersOpen;
  var filtersBtn = document.getElementById("search-filters-btn");
  if (filtersBtn) filtersBtn.setAttribute("aria-expanded", searchFiltersOpen ? "true" : "false");
  var bubble = document.getElementById("search-archived-bubble");
  if (bubble) {
    bubble.classList.toggle("active", searchArchived);
    bubble.setAttribute("aria-pressed", searchArchived ? "true" : "false");
  }
  renderSearchResults();
}

function renderSearchResults() {
  var wrap = document.getElementById("search-results");
  if (!wrap || !state) return;
  wrap.innerHTML = "";
  var hasWords = searchText.trim().length > 0;
  var hasFilters = !!(searchBoardId || searchProjectId || searchLabelId || searchArchived);
  if (!hasWords && !hasFilters) {
    var hint = document.createElement("p");
    hint.className = "search-hint";
    hint.textContent = "Type to search your cards, or open Filters to narrow by board, project or label.";
    wrap.appendChild(hint);
    return;
  }
  var boardOrder = {};
  var columnOrder = {};
  var columnName = {};
  state.boards.forEach(function (b, i) {
    boardOrder[b.id] = i;
    columnOrder[b.id] = {};
    columnName[b.id] = {};
    columnsOf(b).forEach(function (c, j) {
      columnOrder[b.id][c.kind] = j;
      columnName[b.id][c.kind] = c.name;
    });
  });
  var matches = state.cards.filter(searchMatches);
  matches.sort(function (a, b) {
    var byBoard = (boardOrder[a.boardId] || 0) - (boardOrder[b.boardId] || 0);
    if (byBoard !== 0) return byBoard;
    var byColumn = (columnOrder[a.boardId][a.columnId] || 0) - (columnOrder[b.boardId][b.columnId] || 0);
    return byColumn !== 0 ? byColumn : a.position - b.position;
  });
  if (!matches.length) {
    var empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = "No cards match.";
    wrap.appendChild(empty);
    return;
  }
  matches.forEach(function (card) {
    var board = findBoard(card.boardId);
    var row = document.createElement("button");
    row.type = "button";
    row.className = "search-result";
    var title = document.createElement("span");
    title.className = "search-result-title";
    title.textContent = card.title;
    row.appendChild(title);
    var meta = document.createElement("span");
    meta.className = "search-result-meta";
    meta.textContent = (board ? board.name : "") + " · " + (columnName[card.boardId][card.columnId] || "");
    row.appendChild(meta);
    if (isLateCard(card)) {
      var late = document.createElement("span");
      late.className = "late-tag";
      late.textContent = "Late";
      row.appendChild(late);
    }
    row.addEventListener("click", function () { openEditor(card.id); });
    wrap.appendChild(row);
  });
}

// The Archived list: every archived card of the board in view,
// standing under the columns. The section stands closed
// (issue #26): its heading line names the count and carries
// the toggle, and the rows are built only while the section
// stands open, so a board's archived cards never stand as a
// wall under its work. Each row names the card and the
// column Restore will take it back to, and carries Restore and
// Delete. Delete asks first, in the delete dialog (issue #97) —
// the same dialog the editor's Delete opens, in the same words.
// The section hides itself while the board holds no archived
// cards.
function renderArchived(columns) {
  var section = document.getElementById("archived-section");
  var list = document.getElementById("archived-list");
  if (!section || !list || !state) return;
  // The open state belongs to the board in view: a board the
  // list has not been opened on starts closed.
  if (archivedOpenBoard !== state.activeBoard) {
    archivedOpenBoard = state.activeBoard;
    archivedOpen = false;
  }
  var archived = state.cards.filter(function (c) {
    return c.boardId === state.activeBoard && c.archived;
  });
  var order = {};
  columns.forEach(function (col, i) { order[col.kind] = i; });
  archived.sort(function (a, b) {
    var byColumn = (order[a.columnId] || 0) - (order[b.columnId] || 0);
    return byColumn !== 0 ? byColumn : a.position - b.position;
  });
  section.hidden = archived.length === 0;
  var toggle = document.getElementById("archived-toggle");
  if (toggle) {
    toggle.textContent = "Archived (" + archived.length + ")";
    toggle.setAttribute("aria-expanded", archivedOpen ? "true" : "false");
  }
  list.innerHTML = "";
  if (!archivedOpen) return;
  archived.forEach(function (card) {
    var row = document.createElement("div");
    row.className = "archived-row";
    row.setAttribute("data-archived-card", card.id);

    var title = document.createElement("span");
    title.className = "archived-title";
    title.textContent = card.title && card.title.trim() ? card.title : "Untitled card";
    row.appendChild(title);

    var home = columns.find(function (col) { return col.kind === card.columnId; });
    var from = document.createElement("span");
    from.className = "archived-from";
    from.textContent = home ? "From " + home.name : "From the first column";
    row.appendChild(from);

    var rowActions = document.createElement("span");
    rowActions.className = "archived-actions";
    var restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "btn";
    restoreBtn.setAttribute("data-role", "archived-restore");
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", function () { restoreArchivedCard(card); });
    rowActions.appendChild(restoreBtn);
    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-danger";
    deleteBtn.setAttribute("data-role", "archived-delete");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", function () {
      openCardDeleteDialog(card, false);
    });
    rowActions.appendChild(deleteBtn);
    row.appendChild(rowActions);
    list.appendChild(row);
  });
}

// Restore takes a card back to the column it was archived from,
// at the end of that column. A card whose column is gone stands
// in the board's first column already: the API moved it there
// when the column went, so restoring is one un-archive either
// way.
function restoreArchivedCard(card) {
  var siblings = cardsFor(card.boardId, card.columnId);
  var last = siblings.length ? Math.max.apply(null, siblings.map(function (c) { return c.position; })) : -1;
  card.position = last + 1;
  card.archived = false;
  saveQueued(function () {
    return api("PATCH", "/api/cards/" + encodeURIComponent(card.id), { archived: false, position: card.position });
  })
    .catch(function () { /* reloadState already ran */ });
  render();
}

function deleteArchivedCard(card) {
  state.cards = state.cards.filter(function (c) { return c.id !== card.id; });
  saveQueued(function () {
    return api("DELETE", "/api/cards/" + encodeURIComponent(card.id));
  })
    .catch(function () { /* reloadState already ran */ });
  render();
}

// The overview's strips. Each one names its column, counts its
// cards and lists the cards as one-line titles, and that is all:
// no grips, no plus, nothing to edit, however the display mode
// stands, because reading the names and titles is the overview's
// whole job. A tap anywhere on a strip lands inside that column
// at full size, the way a chip does, and the strip for the column
// the person came from carries a ring so they can see where they
// stand. The cards are the same cards the full-size view shows,
// so a project filter counts and lists here too.
function renderOverview(overviewEl, columns) {
  overviewEl.innerHTML = "";
  columns.forEach(function (col) {
    var cards = cardsFor(state.activeBoard, col.kind);

    var strip = document.createElement("div");
    strip.className = "ov-strip" + (col.kind === state.activeColumn ? " current" : "");
    strip.setAttribute("data-ov-column", col.kind);
    strip.setAttribute("role", "button");
    strip.setAttribute("tabindex", "0");
    strip.setAttribute("aria-label",
      col.name + ", " + cards.length + (cards.length === 1 ? " card" : " cards") + ". Open this column.");

    var head = document.createElement("div");
    head.className = "ov-head";
    var headTop = document.createElement("div");
    headTop.className = "ov-head-top";
    var icon = document.createElement("span");
    icon.className = "ov-icon";
    icon.setAttribute("data-role", "column-icon");
    icon.textContent = columnIcon(col);
    headTop.appendChild(icon);
    var count = document.createElement("span");
    count.className = "ov-count";
    count.textContent = String(cards.length);
    headTop.appendChild(count);
    head.appendChild(headTop);
    var stripName = document.createElement("span");
    stripName.className = "ov-name";
    stripName.textContent = col.name;
    head.appendChild(stripName);
    strip.appendChild(head);

    var list = document.createElement("div");
    list.className = "ov-cards";
    if (cards.length === 0) {
      var empty = document.createElement("p");
      empty.className = "ov-empty";
      empty.textContent = "No cards here.";
      list.appendChild(empty);
    }
    cards.forEach(function (card) {
      var row = document.createElement("span");
      row.className = "ov-card";
      row.textContent = card.title;
      // The overview is the board zoomed out, so the board's
      // label paint stands here too — at the rows' smaller
      // scale, where the lines read as lines (issue #95).
      paintCardByLabel(row, activeBoardObj(), cardLabels(card), "mini");
      list.appendChild(row);
    });
    strip.appendChild(list);

    function land() {
      state.activeColumn = col.kind;
      overviewOpen = false;
      render();
    }
    strip.addEventListener("click", land);
    strip.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        land();
      }
    });
    overviewEl.appendChild(strip);
  });
}

function moveCard(id, columnKind, stayOnColumn) {
  var card = findCard(id);
  if (!card) return;
  card.columnId = columnKind;
  if (!stayOnColumn) state.activeColumn = columnKind;
  render();
  if (!isTempId(card.id)) {
    saveQueued(function () {
      return api("PATCH", "/api/cards/" + encodeURIComponent(card.id), { column_id: columnKind });
    }).catch(function () { /* reloadState already ran */ });
  }
}

// --- Dragging cards ---
//
// Dragging is pointer-based, so one model serves the mouse and
// touch. A press becomes a drag only once it has moved a few
// pixels, so an ordinary click still opens the editor, and the
// click a finished drag leaves behind is swallowed (see
// suppressCardClick and the card's click handler).
//
// A mouse drag can start anywhere on the card. A touch drag starts
// only from the card's grip: a touch anywhere else on a card
// scrolls the column, and a sideways one pages between columns
// (the swipe below). On the phone a drag also stays inside the
// column it started in — moving a card to another column there
// stays with the editor's Move buttons. On desktop a drag can
// cross into another column and land at the spot the indicator
// shows.
//
// While a drag runs, the card itself leaves the list and two
// stand-ins take over: a dashed indicator in the list, marking the
// place the card will land, and a copy of the card that follows
// the pointer. The board is not repainted mid-drag — a push
// refresh waits, the way it always has, because dragId names the
// card from the moment the drag starts until the drop lands it.
// One drop is one write: the card's new column and the place it
// takes in it ride in a single PATCH, and the server writes the
// column's order back as one clean run around it.

var DRAG_THRESHOLD = 6;
var dragCandidate = null;
var dragState = null;
var suppressCardClick = false;
var suppressAddClick = false;

function isPhoneLayout() {
  return window.matchMedia("(max-width: 899px)").matches;
}

// A press on a card. Nothing is a drag yet: this only remembers
// where the press began, and the window's move handler decides.
function watchCardPointer(ev, card, el) {
  if (!ev.isPrimary || dragCandidate || dragState) return;
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  var fromGrip = !!(ev.target && ev.target.closest && ev.target.closest('[data-role="card-grip"]'));
  if (ev.pointerType === "touch" && !fromGrip) return;
  dragCandidate = {
    id: card.id,
    el: el,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY
  };
}

function beginDrag() {
  var c = dragCandidate;
  // The board may have been repainted under the press (a push
  // landed first). A card that is no longer on screen cannot drag.
  if (!c || !document.contains(c.el)) { dragCandidate = null; return; }
  var el = c.el;
  var section = el.closest(".column");
  if (!section) { dragCandidate = null; return; }
  var rect = el.getBoundingClientRect();

  var indicator = document.createElement("div");
  indicator.className = "drop-indicator";
  indicator.style.height = rect.height + "px";
  el.parentNode.insertBefore(indicator, el);

  var ghost = el.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.width = rect.width + "px";
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  document.body.appendChild(ghost);

  el.style.display = "none";
  section.classList.add("drag-over");
  document.body.classList.add("dragging-card");

  dragState = {
    id: c.id,
    el: el,
    ghost: ghost,
    indicator: indicator,
    sourceKind: section.getAttribute("data-column"),
    sourceSection: section,
    targetSection: section,
    targetKind: section.getAttribute("data-column"),
    listEl: el.parentNode,
    grabDX: c.startX - rect.left,
    grabDY: c.startY - rect.top,
    targetIndex: 0,
    // A phone drag can end on a column chip instead of in the
    // list: the chip under the pointer, while there is one.
    chipEl: null,
    chipKind: null
  };
  // The push path defers its repaint while dragId is set, and
  // re-checks when this drag ends in endDrag or cancelDrag.
  dragId = c.id;
  dragState.targetIndex = dragIndexAtIndicator();
}

// The active cards of one column of the board on screen, in the
// order they stand, leaving one card out. This is the run a drop's
// place counts in: the project filter can hide cards from the
// screen, never from the column, so a place found against the
// visible cards is translated into this run before anything moves.
function columnCardsExcluding(boardId, columnKind, excludeId) {
  if (!state) return [];
  return state.cards.filter(function (c) {
    return c.boardId === boardId && c.columnId === columnKind && !c.archived && c.id !== excludeId;
  });
}

function indexOfCardId(cards, id) {
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].id === id) return i;
  }
  return -1;
}

// The place the indicator marks, counted in the target column's
// full run of cards: the place of the visible card standing after
// it, or one past the visible card before it, or the end of the
// run when the column shows no other card.
function dragIndexAtIndicator() {
  var ind = dragState.indicator;
  var card = findCard(dragState.id);
  var boardId = card ? card.boardId : state.activeBoard;
  var others = columnCardsExcluding(boardId, dragState.targetKind, dragState.id);
  var sib = ind.nextElementSibling;
  while (sib) {
    if (sib.classList.contains("card") && sib.style.display !== "none") {
      var nextIndex = indexOfCardId(others, sib.getAttribute("data-card"));
      if (nextIndex !== -1) return nextIndex;
      break;
    }
    sib = sib.nextElementSibling;
  }
  sib = ind.previousElementSibling;
  while (sib) {
    if (sib.classList.contains("card") && sib.style.display !== "none") {
      var prevIndex = indexOfCardId(others, sib.getAttribute("data-card"));
      if (prevIndex !== -1) return prevIndex + 1;
      break;
    }
    sib = sib.previousElementSibling;
  }
  return others.length;
}

// The chip a phone drag is hovering, marked while it is the
// drop's target and unmarked as the pointer moves on. The
// source column's own chip is never a target: dropping there is
// the ordinary in-column drop the list already handles.
function markDragChip(chip) {
  var d = dragState;
  if (!d || d.chipEl === chip) return;
  if (d.chipEl) d.chipEl.classList.remove("drop-target");
  d.chipEl = chip || null;
  d.chipKind = chip ? chip.getAttribute("data-column") : null;
  if (d.chipEl) d.chipEl.classList.add("drop-target");
}

function moveDrag(ev) {
  var d = dragState;
  d.ghost.style.left = (ev.clientX - d.grabDX) + "px";
  d.ghost.style.top = (ev.clientY - d.grabDY) + "px";

  var section = null;
  if (isPhoneLayout()) {
    // A phone drag stays in the column it started in — unless it
    // ends on another column's chip, which the drop reads.
    section = d.sourceSection;
    var node = document.elementFromPoint(ev.clientX, ev.clientY);
    var chip = node && node.closest ? node.closest('.step-btn[data-column]') : null;
    if (chip && chip.getAttribute("data-column") === d.sourceKind) chip = null;
    markDragChip(chip);
  } else {
    var node = document.elementFromPoint(ev.clientX, ev.clientY);
    if (node && node.closest) section = node.closest(".column");
    if (!section) section = d.targetSection;
  }
  if (section !== d.targetSection) {
    d.targetSection.classList.remove("drag-over");
    section.classList.add("drag-over");
    d.targetSection = section;
    d.targetKind = section.getAttribute("data-column");
    d.listEl = section.querySelector(".card-list");
  }

  // The indicator stands before the first card whose middle is
  // below the pointer, or at the list's end.
  var cards = d.listEl.querySelectorAll(".card");
  var before = null;
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].style.display === "none") continue;
    var r = cards[i].getBoundingClientRect();
    if (ev.clientY < r.top + r.height / 2) { before = cards[i]; break; }
  }
  if (before) d.listEl.insertBefore(d.indicator, before);
  else d.listEl.appendChild(d.indicator);
  d.targetIndex = dragIndexAtIndicator();

  // A long column scrolls with the drag when the pointer nears
  // the top or bottom of the window.
  if (ev.clientY < 72) window.scrollBy(0, -14);
  else if (ev.clientY > window.innerHeight - 72) window.scrollBy(0, 14);
}

// Puts the dragged card's column order into the state the drop
// chose, so the repaint shows exactly what the server will hold:
// the dragged card spliced into its new column's run at the drop's
// place, both columns' positions written as clean runs, and the
// state set in that order.
function applyLocalCardOrder(card, targetKind, targetIndex) {
  var boardId = card.boardId;
  var sourceKind = card.columnId;
  var target = columnCardsExcluding(boardId, targetKind, card.id);
  var at = Math.max(0, Math.min(targetIndex, target.length));
  target.splice(at, 0, card);
  card.columnId = targetKind;
  target.forEach(function (c, i) { c.position = i; });
  if (sourceKind !== targetKind) {
    columnCardsExcluding(boardId, sourceKind, null).forEach(function (c, i) { c.position = i; });
  }
  state.cards.sort(function (a, b) {
    if (a.boardId !== b.boardId) return a.boardId < b.boardId ? -1 : 1;
    if (a.columnId !== b.columnId) return a.columnId < b.columnId ? -1 : 1;
    return (a.position || 0) - (b.position || 0);
  });
}

// Takes the drag's stand-ins off the screen and the drag's marks
// off the board. The state itself is the caller's to settle.
function teardownDrag() {
  var d = dragState;
  if (!d) return;
  d.ghost.remove();
  d.indicator.remove();
  d.el.style.display = "";
  if (d.targetSection) d.targetSection.classList.remove("drag-over");
  if (d.chipEl) d.chipEl.classList.remove("drop-target");
  document.body.classList.remove("dragging-card");
  dragState = null;
  dragCandidate = null;
  dragId = null;
}

// Brings a card onto the screen after a drop moved the view to
// its column: the column pages in, and the card scrolls to stand
// in view.
function scrollCardIntoView(cardId) {
  var el = document.querySelector('.card[data-card="' + cardId + '"]');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
}

function endDrag() {
  var d = dragState;
  if (!d) return;
  var card = findCard(d.id);
  // A drop on a column chip: the card lands at the end of that
  // column, the view pages to the column and the card stands in
  // view. One write carries the move, as every drop does.
  if (card && d.chipKind && d.chipKind !== d.sourceKind) {
    var chipKind = d.chipKind;
    var endIndex = columnCardsExcluding(card.boardId, chipKind, null).length;
    teardownDrag();
    swallowDragClick();
    applyLocalCardOrder(card, chipKind, endIndex);
    state.activeColumn = chipKind;
    render();
    scrollCardIntoView(card.id);
    if (!isTempId(card.id)) {
      var chipCard = card;
      saveQueued(function () {
        return api("PATCH", "/api/cards/" + encodeURIComponent(realId(chipCard.id)), {
          column_id: chipKind,
          position: endIndex
        });
      }).catch(function () { /* reloadState already ran */ });
    }
    applyPushRefresh();
    return;
  }
  var targetKind = d.targetKind;
  var targetIndex = dragIndexAtIndicator();
  var sourceKind = d.sourceKind;
  teardownDrag();
  swallowDragClick();
  if (card) {
    var fullRun = columnCardsExcluding(card.boardId, sourceKind, null);
    var originalIndex = indexOfCardId(fullRun, card.id);
    if (targetKind !== sourceKind || targetIndex !== originalIndex) {
      applyLocalCardOrder(card, targetKind, targetIndex);
      render();
      if (!isTempId(card.id)) {
        var movedCard = card;
        saveQueued(function () {
          return api("PATCH", "/api/cards/" + encodeURIComponent(realId(movedCard.id)), {
            column_id: targetKind,
            position: targetIndex
          });
        }).catch(function () { /* reloadState already ran */ });
      }
    }
  }
  applyPushRefresh();
}

function cancelDrag() {
  if (!dragState) { dragCandidate = null; return; }
  teardownDrag();
  swallowDragClick();
  applyPushRefresh();
}

// The click a drag leaves behind is dispatched in the same turn
// as the pointerup that ended the drag, before any timer runs.
// Holding the swallow for exactly that turn eats the drag's own
// click and nothing else: a person's next click, however quick,
// lands in a later turn and opens the editor as it should.
function swallowDragClick() {
  suppressCardClick = true;
  setTimeout(function () { suppressCardClick = false; }, 0);
}

// The same one-turn swallow for a column's plus button: a press
// that began on the plus and travelled sideways is a swipe (the
// swipe section below), and the click its release can leave
// behind on that button is not an add. The swipe's end calls
// this, from onPointerUp and onPointerCancel.
function swallowAddClick() {
  suppressAddClick = true;
  setTimeout(function () { suppressAddClick = false; }, 0);
}

// --- Dragging checklist steps ---
//
// A step is picked up by its grip and only by its grip, with the
// mouse or a touch alike: a press on the step's text or its tick
// box edits, ticks or scrolls, never drags. The drag mirrors the
// card drag in miniature — the row steps out of the list, a
// dashed indicator marks the landing place and a copy of the row
// follows the pointer — and one drop is one write: the moved
// step's new place rides in a single PATCH, and the server
// writes the card's list back as one clean run around it.

var stepDragCandidate = null;
var stepDragState = null;

// A press on a step's grip. Nothing is a drag yet: this only
// remembers where the press began, and the window's move handler
// decides, the way a card's press does.
function watchStepPointer(ev, card, step, rowEl) {
  if (!ev.isPrimary || stepDragCandidate || stepDragState || dragCandidate || dragState) return;
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  stepDragCandidate = {
    cardId: card.id,
    stepId: step.id,
    rowEl: rowEl,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY
  };
}

function beginStepDrag() {
  var c = stepDragCandidate;
  // The list may have been repainted under the press. A row that
  // is no longer on screen cannot drag.
  if (!c || !document.contains(c.rowEl)) { stepDragCandidate = null; return; }
  var rowEl = c.rowEl;
  var listEl = rowEl.parentNode;
  if (!listEl) { stepDragCandidate = null; return; }
  var rect = rowEl.getBoundingClientRect();

  var indicator = document.createElement("div");
  indicator.className = "drop-indicator";
  indicator.style.height = rect.height + "px";
  listEl.insertBefore(indicator, rowEl);

  var ghost = rowEl.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.classList.add("step-drag-ghost");
  ghost.style.width = rect.width + "px";
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  document.body.appendChild(ghost);

  rowEl.style.display = "none";
  document.body.classList.add("dragging-card");

  stepDragState = {
    cardId: c.cardId,
    stepId: c.stepId,
    rowEl: rowEl,
    listEl: listEl,
    ghost: ghost,
    indicator: indicator,
    grabDY: c.startY - rect.top
  };
}

function moveStepDrag(ev) {
  var d = stepDragState;
  d.ghost.style.top = (ev.clientY - d.grabDY) + "px";

  // The indicator stands before the first row whose middle is
  // below the pointer, or at the list's end.
  var rows = d.listEl.querySelectorAll("[data-step-row]");
  var before = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].style.display === "none") continue;
    var r = rows[i].getBoundingClientRect();
    if (ev.clientY < r.top + r.height / 2) { before = rows[i]; break; }
  }
  if (before) d.listEl.insertBefore(d.indicator, before);
  else d.listEl.appendChild(d.indicator);

  // A long checklist scrolls with the drag when the pointer
  // nears the top or bottom of the window, as a column does.
  if (ev.clientY < 72) window.scrollBy(0, -14);
  else if (ev.clientY > window.innerHeight - 72) window.scrollBy(0, 14);
}

// The place the indicator marks, counted in the card's steps
// leaving the dragged step out: the number of standing rows
// before it.
function stepIndexAtIndicator() {
  var ind = stepDragState.indicator;
  var n = 0;
  var sib = ind.parentNode ? ind.parentNode.firstElementChild : null;
  while (sib && sib !== ind) {
    if (sib.hasAttribute("data-step-row") && sib.style.display !== "none") n++;
    sib = sib.nextElementSibling;
  }
  return n;
}

// Takes the drag's stand-ins off the screen. The list itself is
// the caller's to settle.
function teardownStepDrag() {
  var d = stepDragState;
  if (!d) return;
  d.ghost.remove();
  d.indicator.remove();
  d.rowEl.style.display = "";
  document.body.classList.remove("dragging-card");
  stepDragState = null;
  stepDragCandidate = null;
}

function endStepDrag() {
  var d = stepDragState;
  if (!d) return;
  var targetIndex = stepIndexAtIndicator();
  var card = findCard(d.cardId);
  teardownStepDrag();
  if (!card || !card.steps) return;
  var from = -1;
  card.steps.forEach(function (s, i) { if (s.id === d.stepId) from = i; });
  if (from === -1 || targetIndex === from) return;
  var moved = card.steps.splice(from, 1)[0];
  card.steps.splice(targetIndex, 0, moved);
  renderChecklist();
  render();
  queueStepMove(card, moved);
}

function cancelStepDrag() {
  if (!stepDragState) { stepDragCandidate = null; return; }
  teardownStepDrag();
}

// --- Paging between columns with a swipe ---
//
// On the phone one column stands on screen at a time. A sideways
// swipe on the column area pages to the next or the previous
// column, beside the name chips, which keep working. The gesture
// has to be plainly sideways: the column's touch handling lets
// the up-and-down movement scroll (see the touch-action rules in
// styles.css, which hand vertical pans to the browser and leave
// sideways moves delivering pointer events), and a swipe counts
// only when its sideways run clearly outweighs its vertical one.
// A grip drag is exempt: a press that starts on a grip never
// pages, whatever it does.

var SWIPE_MIN = 56;
var swipeTrack = null;

function pageColumn(step) {
  var board = activeBoardObj();
  if (!board) return;
  var kinds = columnsOf(board).map(function (c) { return c.kind; });
  var at = kinds.indexOf(state.activeColumn);
  if (at === -1) return;
  var next = Math.max(0, Math.min(at + step, kinds.length - 1));
  if (next === at) return;
  state.activeColumn = kinds[next];
  render();
}

function watchSwipeStart(ev) {
  if (ev.pointerType !== "touch" || !ev.isPrimary) return;
  if (!isPhoneLayout() || dragId || dragCandidate || dragState) return;
  if (ev.target && ev.target.closest && ev.target.closest('[data-role="card-grip"]')) return;
  swipeTrack = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, done: false };
}

function watchSwipeMove(ev) {
  if (!swipeTrack || swipeTrack.done || ev.pointerId !== swipeTrack.pointerId) return;
  if (dragId || dragState) { swipeTrack = null; return; }
  var dx = ev.clientX - swipeTrack.startX;
  var dy = ev.clientY - swipeTrack.startY;
  if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.6) {
    swipeTrack.done = true;
    pageColumn(dx < 0 ? 1 : -1);
  }
}

// One window-level set of pointer handlers serves the drag and
// the swipe: a press is watched from wherever it began.
function onPointerMove(ev) {
  if (stepDragCandidate && ev.pointerId === stepDragCandidate.pointerId) {
    if (!stepDragState) {
      var stepDx = ev.clientX - stepDragCandidate.startX;
      var stepDy = ev.clientY - stepDragCandidate.startY;
      if (Math.sqrt(stepDx * stepDx + stepDy * stepDy) > DRAG_THRESHOLD) beginStepDrag();
    }
    if (stepDragState) moveStepDrag(ev);
    return;
  }
  if (dragCandidate && ev.pointerId === dragCandidate.pointerId) {
    if (!dragState) {
      var dx = ev.clientX - dragCandidate.startX;
      var dy = ev.clientY - dragCandidate.startY;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) beginDrag();
    }
    if (dragState) moveDrag(ev);
    return;
  }
  watchSwipeMove(ev);
}

function onPointerUp(ev) {
  if (stepDragCandidate && ev.pointerId === stepDragCandidate.pointerId) {
    if (stepDragState) endStepDrag();
    else stepDragCandidate = null;
    return;
  }
  if (dragCandidate && ev.pointerId === dragCandidate.pointerId) {
    if (dragState) endDrag();
    else dragCandidate = null;
    return;
  }
  if (swipeTrack && ev.pointerId === swipeTrack.pointerId) {
    // A release that ends a completed swipe is the end of a
    // page turn, not a tap: if the press began on a column's
    // plus, the click the release leaves behind on it is
    // swallowed for this turn (see swallowAddClick).
    if (swipeTrack.done) swallowAddClick();
    swipeTrack = null;
  }
}

function onPointerCancel(ev) {
  if (stepDragCandidate && ev.pointerId === stepDragCandidate.pointerId) {
    cancelStepDrag();
    return;
  }
  if (dragCandidate && ev.pointerId === dragCandidate.pointerId) {
    cancelDrag();
    return;
  }
  if (swipeTrack && ev.pointerId === swipeTrack.pointerId) {
    if (swipeTrack.done) swallowAddClick();
    swipeTrack = null;
  }
}

// --- Card editor ---

// The editor's Labels field: one tick row per label on the board,
// ticked when the card wears it. A tick applies at once, through
// the same commit as every other field, and the card's labels list
// is the value the commit sends — there is no separate field state
// to read back.
function buildLabelTicks(boardId, selectedIds) {
  var wrap = document.getElementById("field-labels");
  wrap.innerHTML = "";
  var worn = selectedIds || [];
  var boardLabels = labelsForBoard(boardId);
  if (!boardLabels.length) {
    var none = document.createElement("p");
    none.className = "field-note";
    none.textContent = "No labels on this board yet. Add them in Settings, under Labels.";
    wrap.appendChild(none);
    return;
  }
  boardLabels.forEach(function (l) {
    var row = document.createElement("label");
    row.className = "label-tick";
    row.setAttribute("data-label-tick", l.id);
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = worn.indexOf(l.id) !== -1;
    box.setAttribute("data-role", "label-tick-box");
    box.setAttribute("aria-label", "Wear the label " + l.name);
    row.appendChild(box);
    row.appendChild(buildChip(l));
    wrap.appendChild(row);
  });
}

function buildProjectOptions(boardId, selectedId) {
  var projectSel = document.getElementById("field-project");
  projectSel.innerHTML = "";
  var noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "No project";
  projectSel.appendChild(noneOpt);
  projectsFor(boardId).forEach(function (proj) {
    var opt = document.createElement("option");
    opt.value = proj.id;
    opt.textContent = proj.icon ? proj.icon + " " + proj.name : proj.name;
    projectSel.appendChild(opt);
  });
  projectSel.value = selectedId || "";
}

// --- The editor session: two hands on one card ---
//
// A card in the open editor can change somewhere else at the same
// time — the person's other device, or their agent through the
// API. The session keeps the two copies from silently overwriting
// each other. When the editor opens, the card's values are the
// ground both sides share (the base). A push brings the server's
// latest values: a field the person has not touched follows the
// server, a field only the person changed keeps the person's
// copy, and a field both sides changed is contested — the next
// save stops and asks, in plain words, whose version stays. The
// editor only ever sends the fields the person changed, so an
// untouched field cannot be written back over a newer value.

var EDITOR_FIELDS = ["title", "notes", "due", "important", "project", "labels"];
var EDITOR_FIELD_NAMES = {
  title: "Title", notes: "Notes", due: "Due date",
  important: "Important", project: "Project", labels: "Labels"
};

// A card's editor values in one shape, from a card as the state
// carries it.
function editorCardValues(card) {
  return {
    title: card.title || "",
    notes: card.notes || "",
    due: card.due || "",
    important: !!card.important,
    project: card.projectId || null,
    labels: (card.labels || []).slice()
  };
}

function copyEditorValues(values) {
  return {
    title: values.title, notes: values.notes, due: values.due,
    important: values.important, project: values.project,
    labels: (values.labels || []).slice()
  };
}

// What the person currently has: the controls' values, and the
// card's own label list, which the tick rows keep.
function editorPersonValues(card) {
  return {
    title: document.getElementById("field-title").value.trim(),
    notes: document.getElementById("field-notes").value,
    due: document.getElementById("field-due").value,
    important: document.getElementById("field-important").checked,
    project: document.getElementById("field-project").value || null,
    labels: (card.labels || []).slice()
  };
}

// Label lists compare as sets: the order the ticks were made in
// is not a difference.
function editorValuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    var sortedA = a.slice().sort();
    var sortedB = b.slice().sort();
    for (var i = 0; i < sortedA.length; i++) {
      if (sortedA[i] !== sortedB[i]) return false;
    }
    return true;
  }
  return a === b;
}

function editorFieldDirty(field, person) {
  if (!editorSession) return false;
  // An emptied title never saves: the card keeps its title, the
  // way the editor has always treated a cleared Title field.
  if (field === "title" && !person.title) return false;
  return !editorValuesEqual(person[field], editorSession.base[field]);
}

// The contested fields: changed by the person, and the server's
// value has moved away from the base to somewhere else again.
function editorConflicts(person) {
  if (!editorSession) return [];
  return EDITOR_FIELDS.filter(function (field) {
    return editorFieldDirty(field, person) &&
      !editorValuesEqual(editorSession.server[field], editorSession.base[field]) &&
      !editorValuesEqual(person[field], editorSession.server[field]);
  });
}

function startEditorSession(card) {
  var values = editorCardValues(card);
  editorSession = { cardId: card.id, base: values, server: copyEditorValues(values) };
  editorPendingAfterConflict = null;
  hideEditorConflict();
}

// Puts one field's value into the editor's controls and the card,
// the way openEditor fills them at the start.
function setEditorField(field, value, card) {
  if (field === "title") document.getElementById("field-title").value = value || "";
  if (field === "notes") document.getElementById("field-notes").value = value || "";
  if (field === "due") document.getElementById("field-due").value = value || "";
  if (field === "important") document.getElementById("field-important").checked = !!value;
  if (field === "project") {
    document.getElementById("field-project").value = value || "";
    card.projectId = value || null;
  }
  if (field === "labels") {
    card.labels = (value || []).slice();
    buildLabelTicks(card.boardId, card.labels);
  }
}

function showEditorConflict(fields) {
  var box = document.getElementById("editor-conflict");
  var text = document.getElementById("editor-conflict-text");
  if (!box || !text) return;
  var names = fields.map(function (field) { return EDITOR_FIELD_NAMES[field]; });
  var list = names.length === 1
    ? names[0]
    : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  text.textContent = "This card changed somewhere else while you were editing it. " +
    list + (names.length === 1 ? " was" : " were") +
    " changed there too. Keep your version, or use theirs?";
  box.hidden = false;
}

function hideEditorConflict() {
  var box = document.getElementById("editor-conflict");
  if (box) box.hidden = true;
}

// The answer to the conflict question. Keep mine: the server's
// values become the new base, so the retry sends the person's
// copy over them. Use theirs: the contested fields take the
// server's values in the editor first, and what is left of the
// person's changes — the uncontested ones — still saves. Either
// way the save then runs again, and anything that was waiting on
// it (a close, a move, an archive, a delete) goes ahead.
function resolveEditorConflict(useTheirs) {
  var card = findCard(editingId);
  if (!card || !editorSession || editorSession.cardId !== card.id) {
    hideEditorConflict();
    editorPendingAfterConflict = null;
    return;
  }
  var conflicts = editorConflicts(editorPersonValues(card));
  conflicts.forEach(function (field) {
    if (useTheirs) setEditorField(field, editorSession.server[field], card);
    editorSession.base[field] = field === "labels"
      ? editorSession.server[field].slice()
      : editorSession.server[field];
  });
  hideEditorConflict();
  if (commitEditorFields() && editorPendingAfterConflict) {
    // The retry save holds the waiting act the way any save
    // holds a close (issue #137): it goes ahead at the
    // settle, and a failed retry leaves the editor open.
    if (editorSavesInFlight > 0) {
      editorCloseWanted = true;
      return;
    }
    var next = editorPendingAfterConflict;
    editorPendingAfterConflict = null;
    next();
  }
}

// Builds the Move buttons for the card's board as it stands, with
// the button for the card's own column marked current. openEditor
// builds them at the start; the push sync rebuilds them when the
// card has moved somewhere else, so the highlight follows.
function buildMoveButtons(card, moveId) {
  var moveWrap = document.getElementById("move-buttons");
  if (!moveWrap) return;
  moveWrap.innerHTML = "";
  columnsOf(findBoard(card.boardId)).forEach(function (col) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn" + (col.kind === card.columnId ? " current" : "");
    btn.textContent = columnIcon(col) + " " + col.name;
    btn.addEventListener("click", function () {
      if (!commitEditorFields()) {
        editorPendingAfterConflict = function () {
          moveCard(moveId, col.kind, false);
          finishCloseEditor();
        };
        return;
      }
      moveCard(moveId, col.kind, false);
      finishCloseEditor();
    });
    moveWrap.appendChild(btn);
  });
}

// --- The Move board dialog (issue #163) ---
//
// The editor's Move board button opens this dialog over the
// editor. It picks three things: the board, the column on that
// board and the project on that board. The board starts on a
// board that is not the card's own — the first other board in
// board order. The column starts on the chosen board's column
// with the same name as the card's column, or its first column;
// the project on the chosen board's project with the same name
// as the card's, or none. Changing the board pick re-aims the
// other two the same way. Labels live on a board: one crosses
// when the chosen board carries a label with the same name, and
// the dialog names every label that would be left behind, as
// the board pick changes — that line is a courtesy worked out
// here; the server works the crossing out again at write time.
// Confirming sends one card edit naming all three, and the
// editor closes behind a landed move. A refused move keeps the
// dialog standing and shows the server's reason.

var moveBoardCardId = null;

function openMoveBoardDialog() {
  var card = findCard(editingId);
  if (!card || isTempId(card.id) || state.boards.length < 2) return;
  // The editor's own edits settle first, the way a move to
  // another column settles them: a conflict stops the opening
  // and the dialog waits for the answer.
  if (!commitEditorFields()) {
    editorPendingAfterConflict = function () { openMoveBoardDialog(); };
    return;
  }
  moveBoardCardId = card.id;
  var boardSel = document.getElementById("move-board-board");
  boardSel.innerHTML = "";
  state.boards.forEach(function (board) {
    var opt = document.createElement("option");
    opt.value = board.id;
    opt.textContent = boardIcon(board) + " " + board.name;
    boardSel.appendChild(opt);
  });
  var other = state.boards.find(function (b) { return b.id !== card.boardId; });
  boardSel.value = other ? other.id : card.boardId;
  showMoveBoardError("");
  aimMoveBoardPicks(card);
  document.getElementById("move-board-backdrop").hidden = false;
  document.getElementById("move-board-confirm").focus();
}

// Fills the column and project picks for the board the dialog
// names, aimed the way the dialog aims them: by name from the
// card's own column and project.
function aimMoveBoardPicks(card) {
  var boardId = document.getElementById("move-board-board").value;
  var board = findBoard(boardId);
  var myColumn = columnsOf(findBoard(card.boardId)).find(function (c) {
    return c.kind === card.columnId;
  });
  var colSel = document.getElementById("move-board-column");
  colSel.innerHTML = "";
  var cols = columnsOf(board);
  cols.forEach(function (col) {
    var opt = document.createElement("option");
    opt.value = col.kind;
    opt.textContent = columnIcon(col) + " " + col.name;
    colSel.appendChild(opt);
  });
  var sameColumn = myColumn
    ? cols.find(function (c) { return c.name === myColumn.name; })
    : null;
  colSel.value = sameColumn ? sameColumn.kind : (cols.length ? cols[0].kind : "");

  var myProject = card.projectId
    ? (state.projects || []).find(function (p) { return p.id === card.projectId; })
    : null;
  var projSel = document.getElementById("move-board-project");
  projSel.innerHTML = "";
  var noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "No project";
  projSel.appendChild(noneOpt);
  var projs = projectsFor(boardId);
  projs.forEach(function (proj) {
    var opt = document.createElement("option");
    opt.value = proj.id;
    opt.textContent = proj.icon ? proj.icon + " " + proj.name : proj.name;
    projSel.appendChild(opt);
  });
  var sameProject = myProject
    ? projs.find(function (p) { return p.name === myProject.name; })
    : null;
  projSel.value = sameProject ? sameProject.id : "";
  updateMoveBoardLabelsLine(card);
}

// The labels line: every label the card wears that the chosen
// board does not carry under the same name, named in the open.
function updateMoveBoardLabelsLine(card) {
  var line = document.getElementById("move-board-labels");
  if (!line) return;
  var boardId = document.getElementById("move-board-board").value;
  var there = {};
  labelsForBoard(boardId).forEach(function (label) { there[label.name] = true; });
  var left = cardLabels(card).filter(function (label) { return !there[label.name]; });
  if (!left.length) {
    line.hidden = true;
    line.textContent = "";
    return;
  }
  var names = left.map(function (label) { return label.name; });
  var list = names.length === 1
    ? names[0]
    : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  line.textContent = (names.length === 1 ? "The label " : "The labels ") + list +
    (names.length === 1 ? " is" : " are") + " not on that board and will be left behind.";
  line.hidden = false;
}

function showMoveBoardError(text) {
  var el = document.getElementById("move-board-error");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

function closeMoveBoardDialog() {
  moveBoardCardId = null;
  var backdrop = document.getElementById("move-board-backdrop");
  if (backdrop) backdrop.hidden = true;
}

// Standing the dialog down forgets the move; the editor stands
// exactly as it did, and focus returns to its Move board button.
function dismissMoveBoardDialog() {
  closeMoveBoardDialog();
  var btn = document.getElementById("editor-move-board");
  if (btn) btn.focus();
}

function confirmMoveBoard() {
  if (!moveBoardCardId) return;
  var card = findCard(moveBoardCardId);
  if (!card) { closeMoveBoardDialog(); return; }
  var boardId = document.getElementById("move-board-board").value;
  var columnKind = document.getElementById("move-board-column").value;
  var projectId = document.getElementById("move-board-project").value || null;
  if (!boardId || boardId === card.boardId) { closeMoveBoardDialog(); return; }
  var confirmBtn = document.getElementById("move-board-confirm");
  confirmBtn.disabled = true;
  showMoveBoardError("");
  saveQueued(function () {
    return api("PATCH", "/api/cards/" + encodeURIComponent(card.id), {
      board_id: realId(boardId),
      column_id: columnKind,
      project_id: projectId ? realId(projectId) : null
    });
  }).then(function (res) {
    confirmBtn.disabled = false;
    var fresh = findCard(card.id);
    if (fresh && res && res.card) {
      fresh.boardId = res.card.boardId;
      fresh.columnId = res.card.columnId;
      fresh.projectId = res.card.projectId;
      fresh.labels = (res.card.labels || []).slice();
      if (typeof res.card.position === "number") fresh.position = res.card.position;
    }
    closeMoveBoardDialog();
    // The destination board comes on screen, so the card stands
    // in view in its new column as the editor closes.
    state.activeBoard = boardId;
    if (fresh) state.activeColumn = fresh.columnId;
    finishCloseEditor();
  }).catch(function (err) {
    confirmBtn.disabled = false;
    showMoveBoardError(err && err.message ? err.message : "Could not move the card.");
  });
}

// A push brought a fresh copy of the editor's card. Each field is
// settled by the session rules: untouched fields follow the
// server, the person's changed fields keep the person's copy on
// the fresh card, and a field both sides changed stays contested
// for the next save to ask about.
function syncEditorSession(freshCard, person) {
  var server = editorCardValues(freshCard);
  EDITOR_FIELDS.forEach(function (field) {
    var serverValue = server[field];
    editorSession.server[field] = field === "labels" ? serverValue.slice() : serverValue;
    if (editorValuesEqual(serverValue, editorSession.base[field])) {
      // The server did not move this field. The person's label
      // ticks, when they differ, stay on the fresh card.
      if (field === "labels" && !editorValuesEqual(person[field], serverValue)) {
        freshCard.labels = person[field].slice();
      }
      return;
    }
    if (editorValuesEqual(person[field], editorSession.base[field])) {
      // Untouched here and moved there: the field follows.
      setEditorField(field, serverValue, freshCard);
      editorSession.base[field] = field === "labels" ? serverValue.slice() : serverValue;
      return;
    }
    if (editorValuesEqual(person[field], serverValue)) {
      // Both sides arrived at the same value: nothing to ask.
      editorSession.base[field] = field === "labels" ? serverValue.slice() : serverValue;
      return;
    }
    // Contested. The person's copy stays in the editor, and on
    // the card for the fields the card itself carries.
    if (field === "labels") freshCard.labels = person[field].slice();
    if (field === "title") freshCard.title = person[field];
    if (field === "notes") freshCard.notes = person[field];
  });
  buildMoveButtons(freshCard, freshCard.id);
  // The Next step row follows the server copy the same way:
  // the chooser is an act, not a field being edited, so
  // nothing of the person's stands in it to protect.
  buildStepControls(freshCard);
}

// --- The card delete dialog (issue #97) ---
//
// Deleting a card asks in a fresh dialog over whatever stands
// underneath: the card editor keeps its shape and its edits,
// and the board keeps its rows. The editor's Delete and the
// Archived list's Delete open the same dialog. This holds the
// card the open dialog is asking about and where the question
// came from, so confirming lands the way that place lands a
// delete today.

var cardDeleteTarget = null;

function openCardDeleteDialog(card, fromEditor) {
  cardDeleteTarget = { id: card.id, fromEditor: !!fromEditor };
  document.getElementById("card-delete-text").textContent = cardDeleteNote(card);
  document.getElementById("card-delete-backdrop").hidden = false;
  document.getElementById("card-delete-confirm").focus();
}

function closeCardDeleteDialog() {
  cardDeleteTarget = null;
  var backdrop = document.getElementById("card-delete-backdrop");
  if (backdrop) backdrop.hidden = true;
}

// Standing the dialog down forgets the question. Where it was
// asked over the editor, the editor stands exactly as it did,
// and focus returns to its Delete button.
function dismissCardDeleteDialog() {
  var fromEditor = cardDeleteTarget && cardDeleteTarget.fromEditor;
  closeCardDeleteDialog();
  if (fromEditor) {
    var btn = document.getElementById("editor-delete");
    if (btn) btn.focus();
  }
}

function confirmCardDelete() {
  if (!cardDeleteTarget) return;
  var target = cardDeleteTarget;
  var card = findCard(target.id);
  closeCardDeleteDialog();
  if (!card) {
    // The card went while the question stood: nothing to
    // delete. An editor left open on it closes, as it would
    // on any other loss of its card.
    if (target.fromEditor) closeEditor();
    return;
  }
  if (target.fromEditor) {
    state.cards = state.cards.filter(function (c) { return c.id !== card.id; });
    if (!isTempId(card.id)) {
      saveQueued(function () {
        return api("DELETE", "/api/cards/" + encodeURIComponent(card.id));
      })
        .catch(function () { /* reloadState already ran */ });
    }
    closeEditor();
  } else {
    deleteArchivedCard(card);
  }
}

function openEditor(id) {
  var card = findCard(id);
  if (!card) return;
  editingId = id;
  closeCardDeleteDialog();
  document.getElementById("editor-heading").textContent = "Card";
  document.getElementById("field-title").value = card.title;
  buildMakerLine(card);
  document.getElementById("field-notes").value = card.notes || "";
  buildLabelTicks(card.boardId, card.labels || []);
  buildProjectOptions(card.boardId, card.projectId || "");
  document.getElementById("field-due").value = card.due || "";
  document.getElementById("field-important").checked = !!card.important;

  buildMoveButtons(card, id);

  // The Move board button (issue #163) stands for a card that
  // exists, when there is another board to move it to.
  var moveBoardBtn = document.getElementById("editor-move-board");
  if (moveBoardBtn) moveBoardBtn.hidden = isTempId(id) || state.boards.length < 2;

  // A card that exists on the server gets a session, so changes
  // landing elsewhere while it is edited meet the session rules.
  // A card still being created has no other copy to conflict with.
  if (isTempId(id)) {
    editorSession = null;
    editorPendingAfterConflict = null;
    hideEditorConflict();
  } else {
    startEditorSession(card);
  }

  document.getElementById("checklist-add-input").value = "";
  renderChecklist();

  document.getElementById("link-add-url").value = "";
  document.getElementById("link-add-name").value = "";
  showLinkError("");
  renderLinks();

  document.getElementById("comment-add-input").value = "";
  renderComments();

  buildStepControls(card);

  document.getElementById("editor-backdrop").hidden = false;
}

// A column's plus button creates the card on screen at once, in
// that column, and opens the editor on it. The card reaches the
// server the moment it has a title. A card still untitled when the
// editor closes removes itself again in closeEditor, so a plus
// never leaves a blank card behind. When a project filter is active
// the new card starts on that project.
function openNewCard(columnKind) {
  var board = activeBoardObj();
  if (!board) return;
  var targetKind = columnKind || columnsOf(board)[0].kind;
  var card = {
    id: tempId("card"),
    boardId: board.id,
    columnId: targetKind,
    title: "",
    notes: "",
    labels: [],
    due: "",
    projectId: state.projectFilter || null,
    archived: false,
    important: false,
    steps: [],
    links: [],
    comments: [],
    creatorKeyId: null,
    creatorKeyName: null,
    step: { holder: "owner", keyId: null, keyName: null, handedAt: null, handedByKeyName: null, handedByName: null, waiting: false }
  };
  state.cards.unshift(card);
  state.activeColumn = targetKind;
  render();
  openEditor(card.id);
  document.getElementById("field-title").focus();
}

// Sends a just-titled new card to the server and swaps its temporary
// id for the real one, in the state and in the open editor. Edits made
// while the create is in flight stay local; when the real id lands, one
// more patch carries the card's current fields, so the server ends up
// holding exactly what the screen shows.
function createCardOnServer(card) {
  if (card.creating) return;
  card.creating = true;
  var tempRef = card;
  var oldId = card.id;
  queueWrite(function () {
    return api("POST", "/api/cards", {
      board_id: realId(tempRef.boardId),
      column_id: tempRef.columnId,
      title: tempRef.title,
      notes: tempRef.notes,
      labels: (tempRef.labels || []).map(realId),
      project_id: tempRef.projectId ? realId(tempRef.projectId) : null,
      due_date: tempRef.due || null,
      important: !!tempRef.important,
      // A Next step chosen while the card was being made rides
      // the create (issue #119): the person's own step is the
      // create's default and is not named.
      next_step: stepOfCard(tempRef).holder === "agent"
        ? stepOfCard(tempRef).keyId
        : stepOfCard(tempRef).holder === "none" ? "none" : undefined
    });
  }, function (res) {
    tempRef.creating = false;
    idAliases[oldId] = res.card.id;
    tempRef.id = res.card.id;
    // The created card's step as the server stamped it: a card
    // made already handed to a key stands waiting there.
    if (res.card.step) tempRef.step = res.card.step;
    if (editingId === oldId) editingId = res.card.id;
    if (dragId === oldId) dragId = res.card.id;
    if (state && state.cards.indexOf(tempRef) === -1) {
      // The card was deleted or archived away while it was being
      // created. Remove the server's copy too.
      queueWrite(function () {
        return api("DELETE", "/api/cards/" + encodeURIComponent(res.card.id));
      }).catch(function () { /* best effort */ });
      return;
    }
    render();
    // The editor is open on this card under its real id now: it
    // gets a session from the server's copy, so a change landing
    // elsewhere from here on meets the session rules.
    if (editingId === res.card.id) {
      startEditorSession({
        id: res.card.id,
        title: res.card.title, notes: res.card.notes, due: res.card.due,
        important: res.card.important, projectId: res.card.projectId,
        boardId: res.card.boardId, labels: res.card.labels || []
      });
    }
    saveQueued(function () {
      return api("PATCH", "/api/cards/" + encodeURIComponent(tempRef.id), {
        board_id: realId(tempRef.boardId),
        column_id: tempRef.columnId,
        title: tempRef.title,
        notes: tempRef.notes,
        labels: (tempRef.labels || []).map(realId),
        project_id: tempRef.projectId ? realId(tempRef.projectId) : null,
        due_date: tempRef.due || null,
        // A card dragged while its create was in flight already
        // holds its place in its column locally; the place rides
        // along so the server ends up holding it too. A card never
        // dragged holds no place yet and sends none.
        position: typeof tempRef.position === "number" ? tempRef.position : undefined,
        important: !!tempRef.important
      });
    }).catch(function () { /* reloadState already ran */ });
    // Steps added while the card was being created are local only.
    // Create them now, in their order, each from the step as it
    // stands, so a tick or a rename from those moments rides along.
    (tempRef.steps || []).slice().forEach(function (step) {
      if (isTempId(step.id)) queueStepCreate(tempRef, step);
    });
    // Links added in those same moments ride along the same way:
    // create each local one now, in its order, from the link as it
    // stands.
    (tempRef.links || []).slice().forEach(function (link) {
      if (isTempId(link.id)) queueLinkCreate(tempRef, link);
    });
    // Comments left in those same moments ride along the same
    // way again: create each local one now, in its order.
    (tempRef.comments || []).slice().forEach(function (comment) {
      if (isTempId(comment.id)) queueCommentCreate(tempRef, comment);
    });
  }).catch(function () {
    tempRef.creating = false;
    showApiError();
    reloadState();
  });
}

// Edits save themselves. Each editor field commits to the card on its
// own: text fields when they lose focus, the dropdowns and the due
// date the moment they change. There is no Save button anywhere in
// the app. A commit paints at once and sends its API call behind it.
// A commit under a session. Only the fields the person changed
// are painted onto the card and sent; a contested field stops the
// save and asks first. Returns false when a conflict stopped it,
// so the caller (a close, a move, an archive) can wait for the
// answer instead of going ahead over an unasked question.
function commitEditorFields() {
  var card = findCard(editingId);
  if (!card) return true;
  if (isTempId(card.id) || !editorSession || editorSession.cardId !== card.id) {
    commitEditorFieldsLegacy(card);
    return true;
  }
  var person = editorPersonValues(card);
  var conflicts = editorConflicts(person);
  if (conflicts.length) {
    showEditorConflict(conflicts);
    return false;
  }
  hideEditorConflict();
  var changed = EDITOR_FIELDS.filter(function (field) {
    return editorFieldDirty(field, person);
  });
  if (changed.length) sendEditorChanges(card, person, changed);
  return true;
}

// Sends the person's changed fields, and only those. The values
// paint onto the local card at once, the way every commit paints.
// A board move is not a field any more (issue #163): it goes
// through the Move board dialog, as its own one edit.
function sendEditorChanges(card, person, fields) {
  fields.forEach(function (field) {
    if (field === "title") card.title = person.title;
    if (field === "notes") card.notes = person.notes;
    if (field === "due") card.due = person.due;
    if (field === "important") card.important = person.important;
    if (field === "project") card.projectId = person.project;
    if (field === "labels") card.labels = person.labels.slice();
  });
  render();

  var patch = {};
  fields.forEach(function (field) {
    if (field === "title") patch.title = person.title;
    if (field === "notes") patch.notes = person.notes;
    if (field === "due") patch.due_date = person.due || null;
    if (field === "important") patch.important = !!person.important;
    if (field === "project") patch.project_id = person.project ? realId(person.project) : null;
    if (field === "labels") patch.labels = person.labels.map(realId);
  });
  var sentFields = fields.slice();
  var sentPerson = copyEditorValues(person);
  editorSavesInFlight++;
  saveQueued(function () {
    return api("PATCH", "/api/cards/" + encodeURIComponent(card.id), patch);
  }).then(function () {
    // What was sent is the new ground both sides share. On a
    // failure nothing advances: the fields stay changed
    // against the base, so a later commit sends them again.
    if (editorSession && editorSession.cardId === card.id) {
      sentFields.forEach(function (field) {
        editorSession.base[field] = field === "labels" ? sentPerson.labels.slice() : sentPerson[field];
        editorSession.server[field] = field === "labels" ? sentPerson.labels.slice() : sentPerson[field];
      });
    }
    editorSaveSettled(false);
  }).catch(function () {
    // reloadState already ran; the banner stands (a read no
    // longer clears it), and the settle calls off any close
    // that was waiting on this save.
    editorSaveSettled(true);
  });
}

// One editor save has settled, landed or failed (issue #137).
// A close that was waiting on it goes ahead only when every
// save has landed; a failure calls the close off and leaves
// the editor standing open, banner up, text in the fields.
function editorSaveSettled(failed) {
  editorSavesInFlight = Math.max(0, editorSavesInFlight - 1);
  if (failed) editorSaveFailed = true;
  if (!editorCloseWanted || editorSavesInFlight > 0) return;
  editorCloseWanted = false;
  if (editorSaveFailed) {
    editorSaveFailed = false;
    editorPendingAfterConflict = null;
    return;
  }
  var next = editorPendingAfterConflict;
  editorPendingAfterConflict = null;
  if (next) next();
  else finishCloseEditor();
}

// The commit for a card with no session: a card still being
// created, whose fields all ride one patch the way they always
// have, because there is no other copy of it to protect.
function commitEditorFieldsLegacy(card) {
  var title = document.getElementById("field-title").value.trim();
  if (title) card.title = title;
  card.notes = document.getElementById("field-notes").value;

  // The card's labels list itself is kept by the tick rows: each
  // tick updates it and then commits, so there is nothing to read
  // back here. A board move is not read from any field (issue
  // #163): it goes through the Move board dialog.
  var projectVal = document.getElementById("field-project").value;
  card.projectId = projectVal ? projectVal : null;
  card.due = document.getElementById("field-due").value;
  card.important = document.getElementById("field-important").checked;
  render();

  if (isTempId(card.id)) {
    if (card.title) createCardOnServer(card);
    return;
  }
  // The patch is built when the queued step runs, from the card as it
  // stands then, so an id swapped in by an earlier queued step (a
  // label made a moment before) is the real one.
  saveQueued(function () {
    var patch = { title: card.title, notes: card.notes, labels: (card.labels || []).map(realId), project_id: card.projectId ? realId(card.projectId) : null, due_date: card.due || null, important: !!card.important };
    return api("PATCH", "/api/cards/" + encodeURIComponent(card.id), patch);
  }).catch(function () { /* reloadState already ran */ });
}

function closeEditor() {
  // Flush whatever the fields still hold, so closing the editor never
  // loses typed text. A save stopped by a conflict stops the close
  // with it: the editor stays open until the question is answered,
  // and the close goes ahead on the answer.
  if (editingId && !commitEditorFields()) {
    editorPendingAfterConflict = function () { finishCloseEditor(); };
    return;
  }
  // A save still landing holds the close (issue #137): the
  // close waits for the settle, which goes ahead with it when
  // the save lands and calls it off when the save fails.
  if (editorSavesInFlight > 0) {
    editorCloseWanted = true;
    if (!editorPendingAfterConflict) {
      editorPendingAfterConflict = function () { finishCloseEditor(); };
    }
    return;
  }
  finishCloseEditor();
}

// The close itself, once the fields are settled. An untitled card,
// which is what Add creates before anything is typed, removes
// itself instead of staying blank.
function finishCloseEditor() {
  if (editingId) {
    var card = findCard(editingId);
    if (card && !card.title) {
      state.cards = state.cards.filter(function (c) { return c.id !== card.id; });
    }
  }
  editingId = null;
  editorSession = null;
  editorPendingAfterConflict = null;
  editorCloseWanted = false;
  editorSaveFailed = false;
  hideEditorConflict();
  closeCardDeleteDialog();
  var backdrop = document.getElementById("editor-backdrop");
  if (backdrop) backdrop.hidden = true;
  render();
}

// --- The card's checklist ---
//
// Steps belong to the card the way its notes do: they survive
// column moves, board moves, archiving and unarchiving, and they
// are deleted with the card. Each change paints at once and sends
// its own call behind it, through the same write queue as every
// other edit, so a fast run of ticks lands in order and can never
// undo itself. A step's request is built when its queued step runs,
// from the step as it stands then: a step added and ticked in one
// breath reaches the server already ticked, and a step removed
// before its create runs is never created at all.

// A step's text as it stands in the list: plain wrapped text, no
// field and no box around it, so a step of any length reads in
// full. Tapping it swaps in the editing field (see beginStepEdit
// in the editor's wiring); that field is the only input a step
// ever shows, and only for as long as the rename lasts.
function buildStepText(step) {
  var view = document.createElement("span");
  view.className = "step-text";
  view.setAttribute("data-role", "step-text");
  view.setAttribute("tabindex", "0");
  view.textContent = step.text;
  return view;
}

function renderChecklist() {
  var list = document.getElementById("checklist-list");
  if (!list) return;
  list.innerHTML = "";
  var card = findCard(editingId);
  if (!card) return;
  (card.steps || []).forEach(function (step) {
    var row = document.createElement("div");
    row.className = "checklist-row" + (step.done ? " done" : "");
    row.setAttribute("data-step-row", step.id);

    var grip = document.createElement("span");
    grip.className = "step-grip";
    grip.setAttribute("data-role", "step-grip");
    grip.setAttribute("aria-hidden", "true");
    grip.innerHTML = GRIP_ICON;
    row.appendChild(grip);

    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!step.done;
    box.setAttribute("data-role", "step-done");
    box.setAttribute("aria-label", "Step done");
    row.appendChild(box);

    row.appendChild(buildStepText(step));

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-danger";
    removeBtn.setAttribute("data-role", "step-remove");
    removeBtn.textContent = "Remove";
    row.appendChild(removeBtn);

    list.appendChild(row);
  });
}

function queueStepCreate(card, step) {
  saveQueued(function () {
    // The step may have been removed again before its turn came, or
    // its card deleted. Then there is nothing to create.
    if (!state || state.cards.indexOf(card) === -1) return {};
    if ((card.steps || []).indexOf(step) === -1) return {};
    return api("POST", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/steps", { text: step.text, done: step.done });
  }, function (res) {
    if (!res || !res.step) return;
    var oldId = step.id;
    idAliases[oldId] = res.step.id;
    step.id = res.step.id;
    // Point the open editor's row at the real id without rebuilding
    // the list, so a rename being typed in another row survives.
    document.querySelectorAll("[data-step-row]").forEach(function (row) {
      if (row.getAttribute("data-step-row") === oldId) {
        row.setAttribute("data-step-row", res.step.id);
      }
    });
  }).catch(function () { /* reloadState already ran */ });
}

function persistStepAdd(card, step) {
  if (isTempId(card.id)) {
    // The card itself is not on the server yet. Once it has a title,
    // its create carries the local steps with it (createCardOnServer
    // queues a create for each). With no title yet there is nothing
    // to send: the steps wait with the card.
    if (card.title) createCardOnServer(card);
    return;
  }
  queueStepCreate(card, step);
}

function queueStepPatch(card, step) {
  if (isTempId(card.id)) {
    if (card.title) createCardOnServer(card);
    return;
  }
  if (isTempId(step.id)) {
    // The step's create sits ahead of this change in the queue and
    // is built from the step as it stands when it runs, so a change
    // made before the create runs rides along with it. A change
    // made while the create's request is in flight misses that
    // payload: the create has already read the step as it stood,
    // and the step keeps its temporary id until the answer lands,
    // so the change would be lost (issue #8). Queue the change
    // behind the create instead. When its turn comes the create
    // has landed and the step carries its real id, so the patch
    // sends the step as it stands then; a change the create did
    // carry is simply sent again, unchanged. If the step was
    // removed again before its turn, or its create never landed,
    // there is nothing to patch.
    saveQueued(function () {
      if (!state || state.cards.indexOf(card) === -1) return {};
      if ((card.steps || []).indexOf(step) === -1) return {};
      if (isTempId(step.id)) return {};
      return api("PATCH", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/steps/" + encodeURIComponent(step.id), { text: step.text, done: step.done });
    }).catch(function () { /* reloadState already ran */ });
    return;
  }
  saveQueued(function () {
    return api("PATCH", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/steps/" + encodeURIComponent(step.id), { text: step.text, done: step.done });
  }).catch(function () { /* reloadState already ran */ });
}

function queueStepDelete(card, step) {
  // A step still carrying a temporary id never reached the server:
  // its queued create sees the step gone from the card and skips.
  if (isTempId(card.id) || isTempId(step.id)) return;
  var stepId = step.id;
  saveQueued(function () {
    return api("DELETE", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/steps/" + encodeURIComponent(stepId));
  }).catch(function () { /* reloadState already ran */ });
}

function queueStepMove(card, step) {
  if (isTempId(card.id)) {
    // The card itself is not on the server yet: its create carries
    // its steps in the order they stand when it runs, so the move
    // is already in what will be sent.
    if (card.title) createCardOnServer(card);
    return;
  }
  saveQueued(function () {
    // The request is built when its turn comes, from the card as
    // it stands then. A step still carrying a temporary id has its
    // create ahead of this in the queue and is real by the time
    // this runs; a step removed again before its turn has no
    // place to send.
    if (isTempId(step.id)) return {};
    var at = (card.steps || []).indexOf(step);
    if (at === -1) return {};
    return api("PATCH", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/steps/" + encodeURIComponent(step.id), { position: at });
  }).catch(function () { /* reloadState already ran */ });
}

function addStepFromInput() {
  var card = findCard(editingId);
  if (!card) return;
  var input = document.getElementById("checklist-add-input");
  var text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  if (!card.steps) card.steps = [];
  var step = { id: tempId("step"), text: text, done: false };
  card.steps.push(step);
  input.value = "";
  renderChecklist();
  render();
  input.focus();
  persistStepAdd(card, step);
}

// --- The card's links ---
//
// Links belong to the card the way its checklist steps do: they
// survive column moves, board moves, archiving and unarchiving,
// and they are deleted with the card. A link is a web address with
// an optional name, nothing else. Each change paints at once and
// sends its own call behind it, through the same write queue as
// every other edit. A link's request is built when its queued step
// runs, from the link as it stands then: a link added to a card
// whose create is still in flight rides along with that create, and
// a link removed before its create runs is never created at all.

// The same address rule the Worker enforces (cleanLinkUrl there),
// so the editor can refuse a bad address at once, with a clear
// message, and store nothing. The server checks again regardless.
function cleanLinkUrl(value) {
  var raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      // A scheme-shaped prefix is present. A bare host with a port
      // (a name, a colon, then digits) is the one scheme-shaped
      // value that is still an address without a scheme.
      var afterColon = raw.slice(raw.indexOf(":") + 1);
      if (!/^\d+([/?#]|$)/.test(afterColon)) return null;
    }
    raw = "https://" + raw;
  }
  var parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

function showLinkError(message) {
  var el = document.getElementById("link-error");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

// A comment's length cap, the server's own (issue #151). The
// editor judges it before anything is painted or sent: past
// the cap the comment refuses here, with the count named,
// and the draft stays in the box — it never appears posted
// and is never eaten.
var COMMENT_LIMIT = 2000;

function showCommentError(message) {
  var el = document.getElementById("comment-error");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

function commentCapProblem(body) {
  if (body.length <= COMMENT_LIMIT) return null;
  return "That comment is " + body.length.toLocaleString() +
    " characters long. A comment can be at most " +
    COMMENT_LIMIT.toLocaleString() + " characters. Shorten it and try again.";
}

function renderLinks() {
  var list = document.getElementById("links-list");
  if (!list) return;
  list.innerHTML = "";
  var card = findCard(editingId);
  if (!card) return;
  (card.links || []).forEach(function (link) {
    var row = document.createElement("div");
    row.className = "link-row";
    row.setAttribute("data-link-row", link.id);

    // The row's link shows the name, or the address when the link
    // has no name, with the address under a named link. Following
    // it opens the address in a new tab.
    var open = document.createElement("a");
    open.className = "link-open";
    open.href = link.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.title = link.url;
    var name = document.createElement("span");
    name.className = "link-name";
    name.textContent = link.name || link.url;
    open.appendChild(name);
    if (link.name) {
      var addr = document.createElement("span");
      addr.className = "link-url";
      addr.textContent = link.url;
      open.appendChild(addr);
    }
    row.appendChild(open);

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-danger";
    removeBtn.setAttribute("data-role", "link-remove");
    removeBtn.textContent = "Remove";
    row.appendChild(removeBtn);

    list.appendChild(row);
  });
}

function queueLinkCreate(card, link) {
  saveQueued(function () {
    // The link may have been removed again before its turn came, or
    // its card deleted. Then there is nothing to create.
    if (!state || state.cards.indexOf(card) === -1) return {};
    if ((card.links || []).indexOf(link) === -1) return {};
    return api("POST", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/links", { url: link.url, name: link.name });
  }, function (res) {
    if (!res || !res.link) return;
    var oldId = link.id;
    idAliases[oldId] = res.link.id;
    link.id = res.link.id;
    // The stored address is the server's cleaned one. Take it, and
    // point the open editor's row at the real id without rebuilding
    // the list, so text being typed in the add fields survives.
    link.url = res.link.url;
    document.querySelectorAll("[data-link-row]").forEach(function (row) {
      if (row.getAttribute("data-link-row") === oldId) {
        row.setAttribute("data-link-row", res.link.id);
      }
    });
    render();
  }).catch(function (err) {
    // A refusal with a reason (issue #150): the server judged
    // the address itself and said no — the client's own check
    // and the server's can disagree (a percent-encoded junk
    // host is one), and the painted row is then a phantom.
    // It goes, and the refusal lands beside the field in the
    // field's own words, with the banner the generic handler
    // raised standing down: this failure is fully explained
    // here. Failures with no reason keep the standing
    // handling — the banner and the reload.
    if (err && err.status === 400 && err.data && err.data.error) {
      if (card.links) {
        card.links = card.links.filter(function (l) { return l !== link; });
      }
      hideApiError();
      if (editingId === card.id) {
        renderLinks();
        showLinkError("That is not a web address. Give the site's address, like example.com or https://example.com/page.");
      }
      render();
    }
  });
}

function persistLinkAdd(card, link) {
  if (isTempId(card.id)) {
    // The card itself is not on the server yet. Once it has a title,
    // its create carries the local links with it (createCardOnServer
    // queues a create for each). With no title yet there is nothing
    // to send: the links wait with the card.
    if (card.title) createCardOnServer(card);
    return;
  }
  queueLinkCreate(card, link);
}

function queueLinkDelete(card, link) {
  // A link still carrying a temporary id never reached the server:
  // its queued create sees the link gone from the card and skips.
  if (isTempId(card.id) || isTempId(link.id)) return;
  var linkId = link.id;
  saveQueued(function () {
    return api("DELETE", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/links/" + encodeURIComponent(linkId));
  }).catch(function () { /* reloadState already ran */ });
}

function addLinkFromInputs() {
  var card = findCard(editingId);
  if (!card) return;
  var urlInput = document.getElementById("link-add-url");
  var nameInput = document.getElementById("link-add-name");
  var url = cleanLinkUrl(urlInput.value);
  if (!url) {
    showLinkError("That is not a web address. Give the site's address, like example.com or https://example.com/page.");
    urlInput.focus();
    return;
  }
  showLinkError("");
  if (!card.links) card.links = [];
  var link = { id: tempId("link"), url: url, name: nameInput.value.trim() };
  card.links.push(link);
  urlInput.value = "";
  nameInput.value = "";
  renderLinks();
  render();
  urlInput.focus();
  persistLinkAdd(card, link);
}

// --- The card's next step ---
//
// The editor's Next step row (issue #119): the line names the
// holder as the step stands — and, while a hand-over waits for
// its pickup, how long it has waited and that it is not picked
// up. The chooser hands the step over, and the hand-over acts
// at once, the way a Move does. A comment standing in the
// comment box rides with it: the two land as one write, so the
// words that explain the hand-over are part of the same act.
// On a card still being created there is no server copy to
// hand over yet: the choice is kept on the card and rides its
// create, and the comment joins the card's local comments the
// ordinary way.

function stepSelectValue(step) {
  if (step.holder === "agent") return step.keyId || "owner";
  return step.holder;
}

function buildStepControls(card) {
  var select = document.getElementById("field-step");
  if (!select) return;
  select.innerHTML = "";
  var options = [{ value: "owner", name: "You" }];
  (state.keys || []).forEach(function (key) {
    options.push({ value: key.id, name: key.name });
  });
  options.push({ value: "none", name: "No one" });
  options.forEach(function (option) {
    var el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.name;
    select.appendChild(el);
  });
  select.value = stepSelectValue(stepOfCard(card));
  renderStepLine(card);
}

function renderStepLine(card) {
  var line = document.getElementById("step-line");
  if (!line || !card) return;
  var step = stepOfCard(card);
  var holder = step.holder === "owner" ? "You"
    : step.holder === "none" ? "No one"
    : (step.keyName || "An agent");
  var text = "Next step: " + holder;
  if (step.holder !== "none" && step.handedAt) {
    text += " · handed over " + waitedWords(step.handedAt);
  }
  if (step.waiting) text += " · not picked up";
  line.textContent = text;
}

// The step as the app paints it the moment a hand-over is
// chosen, before the server's answer lands: the person is the
// hander, so the hand-over carries no key's name as its
// hander and names the person as its hander instead, and a
// step handed to the person themselves — or to no one —
// never waits.
function paintedStepAfterHandover(value) {
  var stamp = new Date().toISOString();
  var myName = state && state.me ? state.me.name : null;
  if (value === "none") {
    return { holder: "none", keyId: null, keyName: null, handedAt: stamp, handedByKeyName: null, handedByName: myName, waiting: false };
  }
  if (value === "owner") {
    return { holder: "owner", keyId: null, keyName: null, handedAt: stamp, handedByKeyName: null, handedByName: myName, waiting: false };
  }
  var keyName = null;
  (state.keys || []).forEach(function (key) { if (key.id === value) keyName = key.name; });
  return { holder: "agent", keyId: value, keyName: keyName, handedAt: stamp, handedByKeyName: null, handedByName: myName, waiting: true };
}

function handOverFromEditor(value) {
  var card = findCard(editingId);
  if (!card) return;
  var input = document.getElementById("comment-add-input");
  var commentText = input ? input.value.trim() : "";
  // A comment in the box rides the hand-over, so the cap
  // judges it here too (issue #151): past it, the hand-over
  // does not run and the draft stays in the box.
  var capProblem = commentCapProblem(commentText);
  if (capProblem) {
    showCommentError(capProblem);
    if (input) input.focus();
    return;
  }
  showCommentError("");
  var painted = paintedStepAfterHandover(value);
  if (isTempId(card.id)) {
    // No server copy yet: the choice rides the create (see
    // createCardOnServer), so the paint carries no hand-over
    // stamp and no wait — the server stamps both if the card
    // is created already handed to someone else.
    card.step = { holder: painted.holder, keyId: painted.keyId, keyName: painted.keyName, handedAt: null, handedByKeyName: null, handedByName: null, waiting: false };
    if (commentText) {
      if (!card.comments) card.comments = [];
      var localComment = {
        id: tempId("comment"),
        body: commentText,
        createdAt: new Date().toISOString(),
        authorKeyName: null,
        authorName: state && state.me ? state.me.name : null
      };
      card.comments.push(localComment);
      input.value = "";
      renderComments();
      persistCommentAdd(card, localComment);
    }
    renderStepLine(card);
    render();
    return;
  }
  var patch = { next_step: value };
  if (commentText) patch.comment = commentText;
  card.step = painted;
  if (commentText) {
    if (!card.comments) card.comments = [];
    card.comments.push({
      id: tempId("comment"),
      body: commentText,
      createdAt: new Date().toISOString(),
      authorKeyName: null,
      authorName: state && state.me ? state.me.name : null
    });
    input.value = "";
    renderComments();
  }
  renderStepLine(card);
  render();
  editorStepInFlight++;
  saveQueued(function () {
    return api("PATCH", "/api/cards/" + encodeURIComponent(card.id), patch);
  }).then(function (res) {
    editorStepInFlight = Math.max(0, editorStepInFlight - 1);
    if (!res || !res.card) return;
    // The server's copy is the truth: its step stamps and its
    // comment list — the riding comment under its real id —
    // replace the paint.
    card.step = res.card.step;
    if (res.card.comments) card.comments = res.card.comments;
    if (editingId === card.id) {
      buildStepControls(card);
      renderComments();
    }
    render();
  }).catch(function () {
    editorStepInFlight = Math.max(0, editorStepInFlight - 1);
    /* reloadState already ran */
  });
}

// --- The card's comments ---
//
// Comments belong to the card the way its links do: they survive
// column moves, board moves, archiving and unarchiving, and they
// are deleted with the card. A comment is a body of text, the
// time it was written, and its author: every comment wears its
// author's name as a tag — the key's name for a comment an
// agent key wrote, the person's name for theirs — resolved by
// the server from the author's own record as the comments are
// read, so the tag always shows the name they go by now. The list stands in the order the comments were
// written, oldest first. Each change paints at once and sends
// its own call behind it, through the same write queue as every
// other edit, and a comment added to a card whose create is
// still in flight rides along with that create, the way steps
// and links do.

function renderComments() {
  var list = document.getElementById("comments-list");
  if (!list) return;
  list.innerHTML = "";
  var card = findCard(editingId);
  if (!card) return;
  (card.comments || []).forEach(function (comment) {
    var row = document.createElement("div");
    row.className = "comment-row";
    row.setAttribute("data-comment-row", comment.id);

    var body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = comment.body;
    row.appendChild(body);

    var foot = document.createElement("div");
    foot.className = "comment-foot";
    // Every comment names its author (issue #120): the key's
    // name for a key's comment, the person's name for theirs,
    // in the one tag style comments wear.
    var authorName = comment.authorName || comment.authorKeyName;
    if (authorName) {
      var authorTag = buildCreatorTag(authorName);
      authorTag.setAttribute("data-role", "comment-author");
      authorTag.setAttribute("title", comment.authorKeyName
        ? "Written by the " + authorName + " agent key"
        : "Written by " + authorName);
      foot.appendChild(authorTag);
    }
    var when = document.createElement("span");
    when.className = "comment-time";
    when.textContent = formatCommentTime(comment.createdAt);
    foot.appendChild(when);
    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-danger";
    removeBtn.setAttribute("data-role", "comment-remove");
    removeBtn.textContent = "Remove";
    foot.appendChild(removeBtn);
    row.appendChild(foot);

    list.appendChild(row);
  });
}

function queueCommentCreate(card, comment) {
  saveQueued(function () {
    // The comment may have been removed again before its turn
    // came, or its card deleted. Then there is nothing to create.
    if (!state || state.cards.indexOf(card) === -1) return {};
    if ((card.comments || []).indexOf(comment) === -1) return {};
    return api("POST", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/comments", { body: comment.body });
  }, function (res) {
    if (!res || !res.comment) return;
    var oldId = comment.id;
    idAliases[oldId] = res.comment.id;
    comment.id = res.comment.id;
    // The server's stamp is the comment's true time. Take it, and
    // point the open editor's row at the real id without
    // rebuilding the list, so text being typed in the add field
    // survives.
    comment.createdAt = res.comment.createdAt;
    if (res.comment.authorName) comment.authorName = res.comment.authorName;
    document.querySelectorAll("[data-comment-row]").forEach(function (row) {
      if (row.getAttribute("data-comment-row") === oldId) {
        row.setAttribute("data-comment-row", res.comment.id);
      }
    });
  }).catch(function () { /* reloadState already ran */ });
}

function persistCommentAdd(card, comment) {
  if (isTempId(card.id)) {
    // The card itself is not on the server yet. Once it has a
    // title, its create carries the local comments with it
    // (createCardOnServer queues a create for each). With no
    // title yet there is nothing to send: the comments wait with
    // the card.
    if (card.title) createCardOnServer(card);
    return;
  }
  queueCommentCreate(card, comment);
}

function queueCommentDelete(card, comment) {
  // A comment still carrying a temporary id never reached the
  // server: its queued create sees the comment gone from the
  // card and skips.
  if (isTempId(card.id) || isTempId(comment.id)) return;
  var commentId = comment.id;
  saveQueued(function () {
    return api("DELETE", "/api/cards/" + encodeURIComponent(realId(card.id)) + "/comments/" + encodeURIComponent(commentId));
  }).catch(function () { /* reloadState already ran */ });
}

function addCommentFromInput() {
  var card = findCard(editingId);
  if (!card) return;
  var input = document.getElementById("comment-add-input");
  var body = input.value.trim();
  if (!body) {
    input.focus();
    return;
  }
  var capProblem = commentCapProblem(body);
  if (capProblem) {
    showCommentError(capProblem);
    input.focus();
    return;
  }
  showCommentError("");
  if (!card.comments) card.comments = [];
  var comment = {
    id: tempId("comment"),
    body: body,
    createdAt: new Date().toISOString(),
    authorKeyName: null,
    authorName: state && state.me ? state.me.name : null
  };
  card.comments.push(comment);
  input.value = "";
  renderComments();
  render();
  input.focus();
  persistCommentAdd(card, comment);
}

// --- The icon picker ---
//
// One component picks every icon in the app: boards, columns,
// labels and projects all choose through it. A button shows the
// icon in force (or a quiet plus when there is none) and opens a
// small panel: a grid of common emojis to tap, a field where any
// other emoji can be typed or pasted, and a clear button whose
// words the caller sets ("No icon", "Use the default", "Use the
// number"). A pick calls back at once; "" means cleared.

var openIconPanel = null;

function closeIconPanel() {
  if (openIconPanel) {
    openIconPanel.remove();
    openIconPanel = null;
  }
}

function buildIconPicker(getValue, options) {
  var wrap = document.createElement("span");
  wrap.className = "icon-picker";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-picker-btn";
  btn.setAttribute("data-role", "icon-picker-btn");
  btn.setAttribute("aria-label", options.ariaLabel || "Choose an icon");
  wrap.appendChild(btn);

  function paintFace() {
    var value = getValue() || "";
    btn.innerHTML = "";
    if (value) {
      btn.textContent = value;
    } else {
      var plus = document.createElement("span");
      plus.className = "icon-picker-plus";
      plus.textContent = "+";
      btn.appendChild(plus);
    }
    btn.title = value ? "Icon: " + value : "Choose an icon";
  }
  paintFace();

  btn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (openIconPanel && openIconPanel.parentNode === wrap) {
      closeIconPanel();
      return;
    }
    closeIconPanel();
    var panel = document.createElement("div");
    panel.className = "icon-picker-panel";
    panel.setAttribute("data-role", "icon-picker-panel");

    // The picker's filter: each typed word must start some word
    // of the emoji's name or tags — "cat" finds the cat faces and
    // not "education" — and the emoji itself matches too, so
    // pasting one finds it.
    var searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "icon-search-input";
    searchInput.placeholder = "Search emoji";
    searchInput.setAttribute("aria-label", "Search emoji");
    searchInput.setAttribute("data-role", "icon-search");
    panel.appendChild(searchInput);

    var scroll = document.createElement("div");
    scroll.className = "icon-scroll";
    panel.appendChild(scroll);

    function iconCell(entry) {
      var choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = entry[0];
      choice.title = entry[1];
      choice.setAttribute("aria-label", "Use " + entry[1]);
      choice.addEventListener("click", function () {
        closeIconPanel();
        options.onPick(entry[0]);
      });
      return choice;
    }
    function iconGrid(entries) {
      var grid = document.createElement("div");
      grid.className = "icon-grid";
      entries.forEach(function (entry) { grid.appendChild(iconCell(entry)); });
      return grid;
    }
    function iconGridLabel(text) {
      var label = document.createElement("p");
      label.className = "icon-grid-label";
      label.textContent = text;
      return label;
    }

    // Unfiltered, the panel shows the app's defaults pinned in
    // front, then the whole set in its scroll area. Filtered, it
    // shows the one matching run — pinned defaults first, as they
    // stand in the full list's order would bury them.
    function paintIconGrid() {
      scroll.innerHTML = "";
      var words = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) {
        scroll.appendChild(iconGridLabel("App defaults"));
        scroll.appendChild(iconGrid(PINNED_ICONS.map(function (emoji) {
          return EMOJI_BY_CHAR[emoji];
        }).filter(Boolean)));
        scroll.appendChild(iconGridLabel("All emoji"));
        scroll.appendChild(iconGrid(EMOJI_SET));
        return;
      }
      function matches(entry) {
        var nameWords = (entry[1] + " " + entry[2]).toLowerCase().split(/\s+/);
        return words.every(function (w) {
          if (w === entry[0]) return true;
          return nameWords.some(function (hw) { return hw.indexOf(w) === 0; });
        });
      }
      var seen = {};
      var found = [];
      PINNED_ICONS.concat(EMOJI_SET.map(function (e) { return e[0]; })).forEach(function (emoji) {
        if (seen[emoji]) return;
        seen[emoji] = true;
        var entry = EMOJI_BY_CHAR[emoji];
        if (entry && matches(entry)) found.push(entry);
      });
      if (!found.length) {
        var none = document.createElement("p");
        none.className = "icon-no-match";
        none.textContent = "No emoji match.";
        scroll.appendChild(none);
        return;
      }
      scroll.appendChild(iconGrid(found));
    }
    searchInput.addEventListener("input", paintIconGrid);
    paintIconGrid();

    var customRow = document.createElement("div");
    customRow.className = "icon-custom-row";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type or paste any emoji";
    input.setAttribute("aria-label", "Type or paste any emoji");
    input.setAttribute("data-role", "icon-custom-input");
    customRow.appendChild(input);
    panel.appendChild(customRow);

    var msg = document.createElement("p");
    msg.className = "icon-picker-msg";
    msg.setAttribute("data-role", "icon-picker-msg");
    msg.hidden = true;
    panel.appendChild(msg);

    function tryCustom() {
      var cleaned = cleanIconValue(input.value);
      if (cleaned === null || cleaned === "") {
        msg.textContent = "An icon is a single emoji.";
        msg.hidden = false;
        return;
      }
      closeIconPanel();
      options.onPick(cleaned);
    }
    input.addEventListener("keydown", function (ev2) {
      if (ev2.key === "Enter") {
        ev2.preventDefault();
        tryCustom();
      }
    });
    input.addEventListener("change", tryCustom);

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-quiet icon-picker-clear";
    clearBtn.textContent = options.clearLabel || "No icon";
    clearBtn.addEventListener("click", function () {
      closeIconPanel();
      options.onPick("");
    });
    panel.appendChild(clearBtn);

    wrap.appendChild(panel);
    openIconPanel = panel;
    searchInput.focus();
  });

  wrap.refresh = paintFace;
  return wrap;
}

// Mounts a picker in one of the standing add forms and returns it,
// so the form can refresh its face after a pick or a reset.
function mountIconPicker(mountEl, getValue, options) {
  var picker = buildIconPicker(getValue, options);
  // A page missing the mount — an older build's shape — gets the
  // picker unmounted rather than a boot that stops here.
  if (!mountEl) return picker;
  mountEl.innerHTML = "";
  mountEl.appendChild(picker);
  return picker;
}

// --- Press-and-hold rename ---

// A board button and a project button each carry a second action
// beside the tap: press and hold one, or double-click it, and a
// small editor opens on the button holding its name in a field.
// The name paints as the person types, the way the Settings name
// fields paint, and settles when the editor closes: the trimmed
// name saves through the write queue, and a name left empty is
// not applied. The icon stands in the same editor, through the
// picker's own component. A project can also be deleted from
// the same editor; its delete opens the shared project delete
// dialog (issue #99) over the editor, and the cards carry on
// with no project. A board's delete stays in Settings, where
// it lives.
//
// A plain tap still does what it always did — switch board, set
// the filter. A press that travels more than a few pixels is a
// scroll, not a hold, and opens nothing. The release after a
// fired press leaves a click behind on the button; that click is
// the press's, not the button's, and the button's own handler
// swallows it (see pressClickSwallowed below).

var PRESS_MS = 500;
var PRESS_MOVE_MAX = 10;
var pressTrack = null;
var pressEditor = null;

// The swallow for the click a fired press leaves behind: a record
// naming the button it belongs to and the moment it was left. The
// button's own click handler asks for its record by name and
// eats the click when it finds one. The record outlives any
// single turn — a browser that dispatches the release click late
// (Android Chrome does) still meets it standing — and it is good
// only for its own button, so no other click can be eaten by
// mistake. A fresh press anywhere clears a record left standing.
var pressSwallow = null;

function swallowPressClick(kind, id) {
  pressSwallow = { kind: kind, id: id, at: Date.now() };
}

function pressClickSwallowed(kind, id) {
  if (!pressSwallow) return false;
  var hit = pressSwallow.kind === kind && pressSwallow.id === id &&
    Date.now() - pressSwallow.at < 2000;
  if (hit) pressSwallow = null;
  return hit;
}

// The double-click window. A mouse or pen click on a board tab
// or a project pill waits out this window before it applies: a
// second click inside it means the press was a double-click, the
// pending apply is cancelled and the rename editor opens
// instead, so the first click of a double-click never does the
// button's job underneath the editor. Taps and keyboard clicks
// (which carry a click count of 0) apply at once — no window is
// felt where no double-click gesture exists.
var PRESS_DBLCLICK_MS = 300;
var pendingPressApplies = {};
var lastPointerType = "";
var lastPointerAt = 0;

function clickAppliesAtOnce(ev) {
  if (!ev || ev.detail === 0) return true;
  return lastPointerType === "touch" && Date.now() - lastPointerAt < 1000;
}

function deferPressApply(key, apply) {
  cancelPressApply(key);
  pendingPressApplies[key] = setTimeout(function () {
    delete pendingPressApplies[key];
    apply();
  }, PRESS_DBLCLICK_MS);
}

function cancelPressApply(key) {
  if (pendingPressApplies[key]) {
    clearTimeout(pendingPressApplies[key]);
    delete pendingPressApplies[key];
  }
}

function pressEntity(kind, id) {
  return kind === "board" ? findBoard(id) : findProject(id);
}

function pressAnchorFor(kind, id) {
  var selector = kind === "board"
    ? '.board-tab[data-board="' + id + '"]'
    : '.filter-btn[data-project="' + id + '"]';
  return document.querySelector(selector);
}

function cancelPress() {
  if (!pressTrack) return;
  clearTimeout(pressTrack.timer);
  if (pressTrack.el && pressTrack.el.classList) {
    pressTrack.el.classList.remove("press-arming");
  }
  pressTrack = null;
}

function watchPressStart(ev, kind, id, el) {
  if (!state) return;
  if (ev.button !== undefined && ev.button !== 0) return;
  // A press beginning settles an open editor first; the
  // document's own dismissal would land a moment later and find
  // nothing to do.
  if (pressEditor) closePressEditor(true);
  cancelPress();
  var track = {
    kind: kind,
    id: id,
    el: el,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    fired: false,
    timer: null
  };
  track.timer = setTimeout(function () {
    if (pressTrack !== track) return;
    track.fired = true;
    el.classList.remove("press-arming");
    openPressEditor(track.kind, track.id, el);
  }, PRESS_MS);
  pressTrack = track;
  el.classList.add("press-arming");
}

function onPressMove(ev) {
  if (!pressTrack || pressTrack.fired) return;
  if (ev.pointerId !== pressTrack.pointerId) return;
  var dx = ev.clientX - pressTrack.startX;
  var dy = ev.clientY - pressTrack.startY;
  if (Math.sqrt(dx * dx + dy * dy) > PRESS_MOVE_MAX) cancelPress();
}

function onPressEnd(ev) {
  if (!pressTrack) return;
  if (ev.pointerId !== pressTrack.pointerId) return;
  var fired = pressTrack.fired;
  var firedKind = pressTrack.kind;
  var firedId = pressTrack.id;
  cancelPress();
  if (fired) {
    // The click this release leaves behind belongs to the press,
    // not to the button: leave the swallow record naming this
    // button for its own handler to eat, and swallow on a card's
    // handler too if the release travelled off the button before
    // it came up.
    swallowPressClick(firedKind, firedId);
    swallowDragClick();
  }
}

function openPressEditor(kind, id, anchorEl) {
  closeIconPanel();
  if (pressEditor) closePressEditor(true);
  var entity = pressEntity(kind, id);
  if (!entity) return;
  var anchor = anchorEl && anchorEl.isConnected ? anchorEl : pressAnchorFor(kind, id);
  if (!anchor) return;

  var el = document.createElement("div");
  el.className = "press-editor";
  el.setAttribute("data-role", "press-editor");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", kind === "board" ? "Rename board" : "Rename project");

  var main = document.createElement("div");
  main.setAttribute("data-role", "press-editor-main");

  var label = document.createElement("label");
  label.className = "press-editor-label";
  label.setAttribute("for", "press-editor-input");
  label.textContent = kind === "board" ? "Board name" : "Project name";
  main.appendChild(label);

  var input = document.createElement("input");
  input.type = "text";
  input.id = "press-editor-input";
  input.value = entity.name;
  input.setAttribute("data-role", "press-editor-name");
  input.setAttribute("aria-label", kind === "board" ? "Board name" : "Project name");
  input.setAttribute("autocomplete", "off");
  main.appendChild(input);

  // The icon stands in this editor too, through the same picker
  // Settings uses, so changing it takes the same one tap here as
  // there. For a board the picker's face shows the icon in
  // effect, the way the Settings row shows it.
  var iconRow = document.createElement("div");
  iconRow.className = "press-editor-icon-row";
  var iconLabel = document.createElement("span");
  iconLabel.className = "press-editor-label";
  iconLabel.textContent = "Icon";
  iconRow.appendChild(iconLabel);
  var pressPicker = buildIconPicker(function () {
    var current = pressEntity(kind, id);
    if (!current) return "";
    return kind === "board" ? boardIcon(current) : (current.icon || "");
  }, {
    clearLabel: kind === "board" ? "Use the default" : "No icon",
    ariaLabel: kind === "board" ? "Icon for board " + entity.name : "Icon for project " + entity.name,
    onPick: function (picked) {
      var current = pressEntity(kind, id);
      if (!current) return;
      applyIconPick(current, picked, kind === "board" ? "/api/boards/" : "/api/projects/");
      pressPicker.refresh();
    }
  });
  pressPicker.setAttribute("data-role", "press-editor-icon-picker");
  iconRow.appendChild(pressPicker);
  main.appendChild(iconRow);

  var row = document.createElement("div");
  row.className = "press-editor-row";
  var closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-quiet";
  closeBtn.setAttribute("data-role", "press-editor-close");
  closeBtn.textContent = "Close";
  row.appendChild(closeBtn);
  var deleteBtn = null;
  if (kind === "project") {
    deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-danger press-editor-delete";
    deleteBtn.setAttribute("data-role", "press-editor-delete");
    deleteBtn.textContent = "Delete";
    row.appendChild(deleteBtn);
  }
  main.appendChild(row);
  el.appendChild(main);

  document.body.appendChild(el);
  pressEditor = {
    kind: kind,
    id: id,
    original: entity.name,
    el: el,
    input: input
  };
  positionPressEditor(anchor);
  input.focus();
  input.select();

  // The name paints as the person types, the way the Settings
  // name fields paint; the save waits for the editor to settle.
  input.addEventListener("input", function () {
    var current = pressEntity(kind, id);
    if (!current) return;
    current.name = input.value;
    render();
  });
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      closePressEditor(true);
    }
  });
  closeBtn.addEventListener("click", function () { closePressEditor(true); });
  if (deleteBtn) {
    deleteBtn.addEventListener("click", function () {
      if (!pressEditor || pressEditor.kind !== "project") return;
      openProjectDeleteDialog(id, true);
    });
  }
}

// Places the editor under its button, or above it when the room
// below runs out, and keeps it inside the screen's sides.
function positionPressEditor(anchor) {
  if (!pressEditor) return;
  var el = pressEditor.el;
  var rect = anchor.getBoundingClientRect();
  var width = Math.min(280, window.innerWidth - 16);
  el.style.width = width + "px";
  el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
  var height = el.offsetHeight;
  var top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8 && rect.top - height - 6 > 8) {
    top = rect.top - height - 6;
  }
  el.style.top = top + "px";
}

// Settling the editor: a trimmed name that differs from the one
// the editor opened with saves through the write queue, the way
// a Settings rename saves. A name left empty is not applied —
// the painted name goes back to the one the editor opened with.
// A thing still carrying a temporary id keeps its new name in
// state, and its create's follow-up settles the difference with
// the server when the real id lands.
function closePressEditor(commit) {
  if (!pressEditor) return;
  var ed = pressEditor;
  pressEditor = null;
  ed.el.remove();
  if (!commit) return;
  var entity = pressEntity(ed.kind, ed.id);
  if (!entity) return;
  var cleanName = ed.input.value.trim();
  if (!cleanName) {
    entity.name = ed.original;
    render();
    return;
  }
  entity.name = cleanName;
  render();
  if (cleanName === ed.original) return;
  if (isTempId(entity.id)) return;
  var savedId = entity.id;
  var base = ed.kind === "board" ? "/api/boards/" : "/api/projects/";
  saveQueued(function () {
    return api("PATCH", base + encodeURIComponent(savedId), { name: cleanName });
  }).catch(function () { /* reloadState already ran */ });
}

// Deleting the project the editor stands on. The cards keep
// living with no project: their project is cleared here the way
// the server clears it, and if the project was the filter, the
// filter falls back to every project.
// The note a project's delete asks with: how many cards carry
// it and what happens to them. Shared by the press-and-hold
// editor and Settings → Projects, so the two ask in one voice.
function projectDeleteNote(id) {
  var count = state ? state.cards.filter(function (c) { return c.projectId === id && !c.archived; }).length : 0;
  if (count === 0) return "No cards carry it.";
  if (count === 1) return "On 1 card — it will carry on with no project.";
  return "On " + count + " cards — they'll carry on with no project.";
}

// Takes a project out of the state everywhere it shows: the
// list, the cards that carry it and the filter if it names it.
function removeProjectEverywhere(id) {
  state.projects = state.projects.filter(function (p) { return p.id !== id; });
  state.cards.forEach(function (card) {
    if (card.projectId === id) card.projectId = null;
  });
  if (state.projectFilter === id) state.projectFilter = null;
}

// --- The delete dialogs of the dialog sweep (issue #99) ---
//
// Every destructive act asks in a dialog — never an expanding
// form, never a bare click. A project delete is one dialog
// shared by Settings → Projects and the press-and-hold editor:
// it asks over the untouched row or editor, and standing it
// down returns to whichever stands underneath. Board delete
// and label delete, which used to act on one click, ask in
// dialogs of their own naming what goes with them. The facts
// and the effects are exactly what they were; only the shape
// changes.

var projectDeleteTarget = null;

function openProjectDeleteDialog(id, fromPress) {
  var proj = findProject(id);
  if (!proj) return;
  projectDeleteTarget = { id: id, fromPress: !!fromPress };
  document.getElementById("project-delete-text").textContent =
    "Delete “" + proj.name + "”? " + projectDeleteNote(id);
  document.getElementById("project-delete-backdrop").hidden = false;
  document.getElementById("project-delete-confirm").focus();
}

function closeProjectDeleteDialog() {
  projectDeleteTarget = null;
  var backdrop = document.getElementById("project-delete-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmProjectDelete() {
  if (!projectDeleteTarget) return;
  var target = projectDeleteTarget;
  closeProjectDeleteDialog();
  // A delete confirmed over the press editor closes the editor
  // with it — the project it stood on is gone.
  if (target.fromPress && pressEditor && pressEditor.kind === "project" && pressEditor.id === target.id) {
    pressEditor.el.remove();
    pressEditor = null;
  }
  removeProjectEverywhere(target.id);
  render();
  if (!target.fromPress) renderSettings();
  if (!isTempId(target.id)) {
    saveQueued(function () {
      return api("DELETE", "/api/projects/" + encodeURIComponent(target.id));
    }).catch(function () { /* reloadState already ran */ });
  }
}

// The words the board delete dialog carries: the board is
// named, its cards are counted — every one of them, active
// and archived alike, goes with it (issue #134) — and its
// labels and projects are named as going too.
function boardDeleteNote(board) {
  var cards = state ? state.cards.filter(function (c) { return c.boardId === board.id; }).length : 0;
  var labels = labelsForBoard(board.id).length;
  var projects = projectsFor(board.id).length;
  var text = "Delete “" + board.name + "”? ";
  if (cards === 0) text += "It holds no cards. ";
  else if (cards === 1) text += "Its 1 card goes with it. ";
  else text += "Its " + cards + " cards go with it. ";
  var bits = [];
  if (labels) bits.push(labels + (labels === 1 ? " label" : " labels"));
  if (projects) bits.push(projects + (projects === 1 ? " project" : " projects"));
  text += bits.length ? "Its " + bits.join(" and ") + " go with it too." : "It has no labels or projects.";
  return text;
}

var boardDeleteTarget = null;

function openBoardDeleteDialog(board) {
  if (!board || !state) return;
  // The one guard: the last board cannot be deleted — a
  // person always keeps one board. A board holding cards
  // deletes whole behind this dialog (issue #134).
  if (state.boards.length <= 1) return;
  boardDeleteTarget = board.id;
  document.getElementById("board-delete-text").textContent = boardDeleteNote(board);
  document.getElementById("board-delete-backdrop").hidden = false;
  document.getElementById("board-delete-confirm").focus();
}

function closeBoardDeleteDialog() {
  boardDeleteTarget = null;
  var backdrop = document.getElementById("board-delete-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmBoardDelete() {
  if (!boardDeleteTarget) return;
  var deletedId = boardDeleteTarget;
  closeBoardDeleteDialog();
  if (!findBoard(deletedId)) return;
  // Every card on the board goes with it, along with its
  // labels and projects.
  state.boards = state.boards.filter(function (b) { return b.id !== deletedId; });
  state.cards = state.cards.filter(function (c) { return c.boardId !== deletedId; });
  state.labels = state.labels.filter(function (l) { return l.boardId !== deletedId; });
  state.projects = state.projects.filter(function (p) { return p.boardId !== deletedId; });
  if (state.activeBoard === deletedId) {
    state.activeBoard = state.boards.length ? state.boards[0].id : null;
    if (state.activeBoard) applyBoardView(state.activeBoard);
    else state.projectFilter = null;
  }
  render();
  renderSettings();
  if (!isTempId(deletedId)) {
    saveQueued(function () {
      return api("DELETE", "/api/boards/" + encodeURIComponent(deletedId));
    }).catch(function () { /* reloadState already ran */ });
  }
}

// The words the label delete dialog carries: the label is
// named and the count of cards on its board that wear it —
// a plain wording when none do.
function labelDeleteNote(label) {
  var count = state ? state.cards.filter(function (c) {
    return c.boardId === label.boardId && (c.labels || []).indexOf(label.id) !== -1;
  }).length : 0;
  if (count === 0) return "Delete “" + label.name + "”? No cards on its board wear it.";
  if (count === 1) return "Delete “" + label.name + "”? On 1 card on its board — it will come off it.";
  return "Delete “" + label.name + "”? On " + count + " cards on its board — it will come off them.";
}

var labelDeleteTarget = null;

function openLabelDeleteDialog(label) {
  if (!label) return;
  labelDeleteTarget = label.id;
  document.getElementById("label-delete-text").textContent = labelDeleteNote(label);
  document.getElementById("label-delete-backdrop").hidden = false;
  document.getElementById("label-delete-confirm").focus();
}

function closeLabelDeleteDialog() {
  labelDeleteTarget = null;
  var backdrop = document.getElementById("label-delete-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmLabelDelete() {
  if (!labelDeleteTarget) return;
  var deletedId = labelDeleteTarget;
  closeLabelDeleteDialog();
  state.labels = state.labels.filter(function (label) { return label.id !== deletedId; });
  state.cards.forEach(function (card) {
    if (card.labels) {
      card.labels = card.labels.filter(function (id) { return id !== deletedId; });
    }
  });
  render();
  renderSettings();
  if (!isTempId(deletedId)) {
    saveQueued(function () {
      return api("DELETE", "/api/labels/" + encodeURIComponent(deletedId));
    }).catch(function () { /* reloadState already ran */ });
  }
}

// Standing the account delete dialog down clears the typed
// word with it, so a later open starts unarmed, the way the
// expanding box's Cancel did.
function closeAccountDeleteDialog() {
  var type = document.getElementById("account-delete-type");
  if (type) type.value = "";
  var backdrop = document.getElementById("account-delete-backdrop");
  if (backdrop) backdrop.hidden = true;
}

// --- Settings ---

function agentInstructions(name, agentHost) {
  // The short bootstrap (issue #17). This copied text used to carry
  // the whole agent reference; that bulk now lives in the API's own
  // directions, served at GET /api/v1/directions, so a material API
  // change never needs fresh instructions issued. What stays here
  // is only what cannot change with the API: what TaskSparkle is,
  // where the doors are, how a key is made and kept, and the order
  // to read the directions in. Keep it short and stable: every word
  // added here is a word every person must paste again by hand.
  // The agents' door address is not written into this file: the
  // state carries the deployment's configured agent host, so a copy
  // of the app deployed under other names prints its own address.
  // The scheme is this page's own: https on Cloudflare, http on a
  // self-hosted copy, and the printed address follows.
  var base = window.location.protocol + "//" + agentHost + "/api/v1";
  return "Connect to TaskSparkle for me.\n" +
    "My name is " + name + ".\n" +
    "TaskSparkle is my personal kanban board. The boards in it are mine alone and they are private.\n" +
    "Its agent API is at " + base + "\n" +
    "If I have no key yet, tell me to add one in TaskSparkle under Settings, then Set Up Agent: tap Add a key, give it a name, and paste you the key it shows me. The key is shown once, so I copy it then.\n" +
    "When you set up the connection, ask me for my TaskSparkle key and save it in the secure secret field. Send it as Authorization: Bearer <key> on every request, and send an ordinary browser User-Agent on every request.\n" +
    "Then, before anything else, read the directions: GET " + base + "/directions with my key, and follow what they say. They carry the routes, the fields and the rules, and they always match the API that serves them.\n" +
    "Keep my key secret and never show it back to me in full. The key reaches only my boards. If a request comes back 401 or 403, tell me, and I will check the key in TaskSparkle under Settings, then Set Up Agent.";
}

// Fetches the agent directions through this door, signed in, for
// the Set Up Agent panel's read-only view. The api helper parses
// JSON, so this one call reads the raw text itself: the panel
// shows the very text the Worker serves to a key at
// /api/v1/directions, fetched from the same handler here.
function fetchDirectionsText() {
  return fetch("/api/directions").then(function (res) {
    if (!res.ok) throw new Error("directions failed (" + res.status + ")");
    return res.text();
  });
}

function buildPaletteOptions(selected) {
  var html = "";
  LABEL_PALETTE.forEach(function (colour) {
    html += '<option value="' + colour.id + '"' + (colour.id === selected ? " selected" : "") + ">" + colour.name + "</option>";
  });
  return html;
}

// Shows the Settings list, or the one page settingsPage names.
// Every page keeps its own controls and nothing else is on screen.
// --- Copy board ------------------------------------------------
// The Boards page's Copy board dialog. Columns, Labels and
// Projects start ticked and Cards unticked; the name starts as
// "<source> copy". The copy itself is one call, and the board
// list repaints from the fresh state the call leaves behind.

var copySourceId = null;

function openCopyDialog(board) {
  copySourceId = board.id;
  document.getElementById("copy-source").textContent =
    "Copying " + board.name + ". Pick what comes along; archived cards never copy.";
  document.getElementById("copy-name").value = board.name + " copy";
  document.getElementById("copy-columns").checked = true;
  document.getElementById("copy-labels").checked = true;
  document.getElementById("copy-projects").checked = true;
  document.getElementById("copy-cards").checked = false;
  paintCopyWarning();
  document.getElementById("copy-backdrop").hidden = false;
  var nameInput = document.getElementById("copy-name");
  nameInput.focus();
  nameInput.select();
}

function closeCopyDialog() {
  copySourceId = null;
  document.getElementById("copy-backdrop").hidden = true;
}

// The one warning the dialog carries: cards copied without their
// labels or projects land bare, and the line says so before it
// happens.
function paintCopyWarning() {
  var warn = document.getElementById("copy-warn");
  if (!warn) return;
  var cards = document.getElementById("copy-cards").checked;
  var labels = document.getElementById("copy-labels").checked;
  var projects = document.getElementById("copy-projects").checked;
  if (cards && (!labels || !projects)) {
    var missing = [];
    if (!labels) missing.push("their labels");
    if (!projects) missing.push("their projects");
    warn.textContent = "The cards will land without " + missing.join(" or ") + ".";
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

function submitCopyDialog() {
  var name = document.getElementById("copy-name").value.trim();
  if (!name || !copySourceId) return;
  var body = {
    name: name,
    columns: document.getElementById("copy-columns").checked,
    labels: document.getElementById("copy-labels").checked,
    projects: document.getElementById("copy-projects").checked,
    cards: document.getElementById("copy-cards").checked
  };
  var sourceId = copySourceId;
  closeCopyDialog();
  queueWrite(function () {
    return api("POST", "/api/boards/" + encodeURIComponent(sourceId) + "/copy", body);
  }, function () {
    reloadState();
  });
}

// --- Remove column ------------------------------------------------
// The dialog a column's Remove opens when the column holds cards
// (issue #42). It names the column and its card count, and the
// person picks which of the board's other columns receives the
// cards. The confirm paints the move at once and sends the move
// and the removal as one call, the way the server lands them.

var columnRemoveTarget = null;

function openColumnRemoveDialog(board, column) {
  var inColumn = state.cards.filter(function (c) {
    return c.boardId === board.id && c.columnId === column.kind;
  });
  var archivedCount = inColumn.filter(function (c) { return c.archived; }).length;
  columnRemoveTarget = { boardId: board.id, columnId: column.id };
  // An empty column asks too (issue #135): every removal
  // stands behind the same confirm, so no Remove press ever
  // deletes on the spot. The empty shape has no destination
  // to pick — the picker and its label stand down, and the
  // confirm reads as the plain removal it is.
  var empty = inColumn.length === 0;
  var text;
  if (empty) {
    text = "Remove “" + column.name + "”? It holds no cards. " +
      "The column goes, and nothing else changes.";
  } else {
    text = "Remove “" + column.name + "”? It holds " + inColumn.length +
      (inColumn.length === 1 ? " card" : " cards") +
      ". Pick the column that receives them: they land at its end, in their order.";
    if (archivedCount > 0) text += " Archived cards move too and stay archived.";
  }
  document.getElementById("column-remove-text").textContent = text;
  var destRow = document.getElementById("column-remove-dest-row");
  if (destRow) destRow.hidden = empty;
  var submit = document.getElementById("column-remove-submit");
  if (submit) submit.textContent = empty ? "Remove column" : "Move cards and remove column";
  var select = document.getElementById("column-remove-dest");
  select.innerHTML = "";
  columnsOf(board).forEach(function (col) {
    if (col.id === column.id) return;
    var opt = document.createElement("option");
    opt.value = col.id;
    opt.textContent = col.name;
    select.appendChild(opt);
  });
  document.getElementById("column-remove-backdrop").hidden = false;
}

function closeColumnRemoveDialog() {
  columnRemoveTarget = null;
  document.getElementById("column-remove-backdrop").hidden = true;
}

function submitColumnRemoveDialog() {
  if (!columnRemoveTarget) return;
  var boardId = columnRemoveTarget.boardId;
  var columnId = columnRemoveTarget.columnId;
  var select = document.getElementById("column-remove-dest");
  var destId = select ? select.value : null;
  closeColumnRemoveDialog();
  var board = findBoard(boardId);
  if (!board) return;
  var column = null;
  var dest = null;
  columnsOf(board).forEach(function (col) {
    if (col.id === columnId) column = col;
    if (col.id === destId) dest = col;
  });
  if (!column) return;
  // The empty shape removes the column alone (issue #135).
  var held = state.cards.filter(function (c) {
    return c.boardId === board.id && c.columnId === column.kind;
  }).length;
  if (held === 0) {
    removeEmptyColumn(board, column);
    return;
  }
  if (!dest || column.id === dest.id) return;
  applyColumnRemoval(board, column, dest);
}

// Removes a column that holds no cards: out of the board's
// list, the order renumbered, and the view falling back to
// the first column when the removed one stood on screen —
// the paint the dialog's confirm lands (issue #135).
function removeEmptyColumn(board, column) {
  var removedId = column.id;
  var removedKind = column.kind;
  board.columns = board.columns.filter(function (c) { return c.id !== removedId; });
  var ordered = columnsOf(board);
  ordered.forEach(function (col, i) { col.position = i; });
  board.columns = ordered;
  if (state.activeBoard === board.id && state.activeColumn === removedKind) {
    var remaining = columnsOf(board);
    state.activeColumn = remaining.length ? remaining[0].kind : "inbox";
  }
  render();
  renderSettings();
  if (!isTempId(removedId)) {
    saveQueued(function () {
      return api("DELETE", "/api/columns/" + encodeURIComponent(removedId));
    }).catch(function () { /* reloadState already ran */ });
  }
}

function applyColumnRemoval(board, column, dest) {
  // Paint the move the way the server lands it: the incoming
  // active cards take the places after the destination's own
  // actives, in their order, and the archived ones follow, still
  // archived.
  function byPosition(a, b) { return a.position - b.position; }
  var destActives = state.cards.filter(function (c) {
    return c.boardId === board.id && c.columnId === dest.kind && !c.archived;
  }).length;
  var movingActive = state.cards.filter(function (c) {
    return c.boardId === board.id && c.columnId === column.kind && !c.archived;
  }).sort(byPosition);
  var movingArchived = state.cards.filter(function (c) {
    return c.boardId === board.id && c.columnId === column.kind && c.archived;
  }).sort(byPosition);
  movingActive.forEach(function (card, i) {
    card.columnId = dest.kind;
    card.position = destActives + i;
  });
  movingArchived.forEach(function (card, i) {
    card.columnId = dest.kind;
    card.position = destActives + movingActive.length + i;
  });
  var removedId = column.id;
  var removedKind = column.kind;
  board.columns = board.columns.filter(function (c) { return c.id !== removedId; });
  // Renumber what remains. (The settings panel's own renumber
  // helper lives inside its wiring scope, out of reach here.)
  var ordered = columnsOf(board);
  ordered.forEach(function (col, i) { col.position = i; });
  board.columns = ordered;
  if (state.activeBoard === board.id && state.activeColumn === removedKind) {
    var remaining = columnsOf(board);
    state.activeColumn = remaining.length ? remaining[0].kind : "inbox";
  }
  render();
  renderSettings();
  if (!isTempId(removedId)) {
    saveQueued(function () {
      return api("DELETE", "/api/columns/" + encodeURIComponent(removedId), { move_to_column_id: dest.id });
    }).catch(function () { /* reloadState already ran */ });
  }
}

function renderSettingsNav() {
  var list = document.getElementById("settings-list");
  if (list) list.hidden = settingsPage !== null;
  var backRow = document.getElementById("settings-back-row");
  if (backRow) backRow.hidden = settingsPage === null;
  SETTINGS_PAGES.forEach(function (id) {
    var page = document.getElementById(id);
    if (page) page.hidden = settingsPage !== id;
  });
}

// Icon drafts for the two standing add rows and the label add
// rows, keyed by board for labels. A draft is the icon picked for
// a thing that does not exist yet; it rides the create call when
// the thing is made and is gone after.
var boardAddIconDraft = "";
var projectAddIconDraft = "";
var labelAddIconDrafts = {};
var projectAddIconDrafts = {};

// An icon pick on a board, column or label in Settings: the new
// icon paints at once and saves behind it. A thing still carrying
// a temporary id cannot be patched yet, so the pick is kept on it
// as iconPicked and its create's follow-up sends it when the real
// id lands, the way a rename typed in those moments already rides.
function applyIconPick(entity, picked, patchBase) {
  entity.icon = picked;
  if (isTempId(entity.id)) entity.iconPicked = picked;
  render();
  renderSettings();
  if (!isTempId(entity.id)) {
    saveQueued(function () {
      return api("PATCH", patchBase + encodeURIComponent(entity.id), { icon: picked });
    }).catch(function () { /* reloadState already ran */ });
  }
}

function renderSettings() {
  if (!state) return;
  renderSettingsNav();
  var me = state.me;
  document.getElementById("account-name").textContent = me.name;
  // No page shows an email address (issue #114): Google is
  // gone, and an address does no work on screen. The name is
  // the whole identity the Account page states.
  renderPeople();
  // The display-name field shows the name as it stands, unless
  // the person is in the middle of editing it.
  var nameInput = document.getElementById("account-name-input");
  if (nameInput && document.activeElement !== nameInput) nameInput.value = me.name || "";

  // Boards section: one rename row per board. Delete works on
  // any board but the last one, behind the dialog that names
  // its cards (issue #134).
  var boardsWrap = document.getElementById("settings-boards-list");
  boardsWrap.innerHTML = "";
  state.boards.forEach(function (board) {
    var row = document.createElement("div");
    row.className = "board-manage-row";
    row.setAttribute("data-board-row", board.id);

    var boardPicker = buildIconPicker(function () { return boardIcon(board); }, {
      clearLabel: "Use the default",
      ariaLabel: "Icon for board " + board.name,
      onPick: function (picked) { applyIconPick(board, picked, "/api/boards/"); }
    });
    boardPicker.setAttribute("data-role", "board-icon-picker");
    row.appendChild(boardPicker);

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = board.name;
    nameInput.setAttribute("data-role", "board-name");
    nameInput.setAttribute("aria-label", "Board name");
    row.appendChild(nameInput);

    // The board's label colour mode (issue #95): how this
    // board's cards wear their first label's colour. It stands
    // on the board's own row because the mode is part of what
    // tells one board from another — the row shows the mode the
    // board stands in, and choosing another saves at once.
    var modeWrap = document.createElement("label");
    modeWrap.className = "board-mode";
    var modeCaption = document.createElement("span");
    modeCaption.textContent = "Label colour on cards";
    modeWrap.appendChild(modeCaption);
    var modeSelect = document.createElement("select");
    modeSelect.setAttribute("data-role", "board-label-mode");
    modeSelect.setAttribute("aria-label", "Label colour on cards for board " + board.name);
    [["chip", "Just the label"], ["background", "Faded background"],
     ["trim", "Thick trim"], ["top", "Top trim"]].forEach(function (pair) {
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      modeSelect.appendChild(opt);
    });
    modeSelect.value = board.labelColourMode || "chip";
    modeWrap.appendChild(modeSelect);
    row.appendChild(modeWrap);

    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn";
    copyBtn.setAttribute("data-role", "board-copy");
    copyBtn.textContent = "Copy board";
    row.appendChild(copyBtn);

    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-danger";
    deleteBtn.setAttribute("data-role", "board-delete");
    deleteBtn.textContent = "Delete";
    var blockedNote = "";
    if (state.boards.length <= 1) {
      deleteBtn.disabled = true;
      blockedNote = "You must keep at least one board.";
    }
    row.appendChild(deleteBtn);
    if (blockedNote) {
      var note = document.createElement("p");
      note.className = "board-note";
      note.setAttribute("data-role", "board-delete-note");
      note.textContent = blockedNote;
      row.appendChild(note);
    }
    boardsWrap.appendChild(row);
  });

  // Columns section: a board picker, then that board's columns in
  // order. Each row renames in place, moves up or down, or removes.
  // Remove on a column holding cards opens the dialog that asks
  // where its cards go (issue #42); it never works on a board's
  // last column.
  var picker = document.getElementById("columns-board-picker");
  columnsSettingsBoardId = realId(columnsSettingsBoardId);
  if (!findBoard(columnsSettingsBoardId)) {
    columnsSettingsBoardId = state.activeBoard || (state.boards.length ? state.boards[0].id : null);
  }
  picker.innerHTML = "";
  state.boards.forEach(function (board) {
    var opt = document.createElement("option");
    opt.value = board.id;
    opt.textContent = boardIcon(board) + " " + board.name;
    picker.appendChild(opt);
  });
  picker.value = columnsSettingsBoardId || "";
  var columnsBoard = findBoard(columnsSettingsBoardId);
  var columnsWrap = document.getElementById("settings-columns-list");
  columnsWrap.innerHTML = "";
  if (columnsBoard) {
    var boardColumns = columnsOf(columnsBoard);
    boardColumns.forEach(function (col, index) {
      var cardsInColumn = state.cards.filter(function (c) {
        return c.boardId === columnsBoard.id && c.columnId === col.kind;
      }).length;
      var row = document.createElement("div");
      row.className = "column-manage-row";
      row.setAttribute("data-column-row", col.id);

      var colPicker = buildIconPicker(function () { return columnIcon(col); }, {
        clearLabel: "Use the number",
        ariaLabel: "Icon for column " + col.name,
        onPick: function (picked) { applyIconPick(col, picked, "/api/columns/"); }
      });
      colPicker.setAttribute("data-role", "column-icon-picker");
      row.appendChild(colPicker);

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = col.name;
      nameInput.setAttribute("data-role", "column-name");
      nameInput.setAttribute("aria-label", "Column name");
      row.appendChild(nameInput);

      var upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "btn";
      upBtn.setAttribute("data-role", "column-up");
      upBtn.setAttribute("aria-label", "Move column up");
      upBtn.textContent = "↑";
      upBtn.disabled = index === 0;
      row.appendChild(upBtn);

      var downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "btn";
      downBtn.setAttribute("data-role", "column-down");
      downBtn.setAttribute("aria-label", "Move column down");
      downBtn.textContent = "↓";
      downBtn.disabled = index === boardColumns.length - 1;
      row.appendChild(downBtn);

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-danger";
      removeBtn.setAttribute("data-role", "column-remove");
      removeBtn.textContent = "Remove";
      var blockedNote = "";
      if (boardColumns.length <= 1) {
        removeBtn.disabled = true;
        blockedNote = "You must keep at least one column.";
      } else if (cardsInColumn > 0) {
        // Removing a column that holds cards opens the dialog
        // that asks where they go (issue #42); the row says the
        // count before the question is asked.
        blockedNote = "It holds " + cardsInColumn +
          (cardsInColumn === 1 ? " card — removing it asks where it goes."
            : " cards — removing it asks where they go.");
      } else {
        // An empty column asks first too (issue #135); the
        // row says so before the press.
        blockedNote = "It holds no cards — removing it asks first.";
      }
      row.appendChild(removeBtn);
      if (blockedNote) {
        var note = document.createElement("p");
        note.className = "column-note";
        note.setAttribute("data-role", "column-remove-note");
        note.textContent = blockedNote;
        // The warning stands above the Remove button it belongs
        // to (issue #96): first in the row, on its own line,
        // where the person reads it before the button.
        row.insertBefore(note, row.firstChild);
      }
      columnsWrap.appendChild(row);
    });
  }

  // Labels section: a board picker, then that board's labels —
  // the Columns pattern (issue #96). The add row holds text that
  // is not in the state yet, so a rebuild (for example when a
  // slow save returns) must carry the draft across, or what the
  // person typed vanishes under their hands.
  var labelsPicker = document.getElementById("labels-board-picker");
  labelsSettingsBoardId = realId(labelsSettingsBoardId);
  if (!findBoard(labelsSettingsBoardId)) {
    labelsSettingsBoardId = state.activeBoard || (state.boards.length ? state.boards[0].id : null);
  }
  labelsPicker.innerHTML = "";
  state.boards.forEach(function (board) {
    var opt = document.createElement("option");
    opt.value = board.id;
    opt.textContent = boardIcon(board) + " " + board.name;
    labelsPicker.appendChild(opt);
  });
  labelsPicker.value = labelsSettingsBoardId || "";
  var labelsBoard = findBoard(labelsSettingsBoardId);
  var labelsWrap = document.getElementById("settings-labels");
  var addDrafts = {};
  labelsWrap.querySelectorAll("[data-add-for]").forEach(function (row) {
    var draftName = row.querySelector("[data-role='add-name']");
    var draftColour = row.querySelector("[data-role='add-colour']");
    addDrafts[row.getAttribute("data-add-for")] = {
      name: draftName ? draftName.value : "",
      colour: draftColour ? draftColour.value : ""
    };
  });
  labelsWrap.innerHTML = "";
  if (labelsBoard) {
    var board = labelsBoard;
    var boardId = board.id;

    labelsForBoard(boardId).forEach(function (label) {
      var palette = paletteColors(paletteFor(label.colour));
      var row = document.createElement("div");
      row.className = "label-row";
      row.setAttribute("data-label-row", label.id);

      var preview = document.createElement("span");
      preview.className = "label-preview";
      preview.setAttribute("data-role", "preview");
      preview.style.background = palette.bg;
      preview.style.borderColor = palette.border;
      row.appendChild(preview);

      var labelPicker = buildIconPicker(function () { return label.icon || ""; }, {
        clearLabel: "No icon",
        ariaLabel: "Icon for label " + label.name,
        onPick: function (picked) { applyIconPick(label, picked, "/api/labels/"); }
      });
      labelPicker.setAttribute("data-role", "label-icon-picker");
      row.appendChild(labelPicker);

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = label.name;
      nameInput.setAttribute("data-role", "name");
      nameInput.setAttribute("aria-label", "Label name");
      row.appendChild(nameInput);

      var colourSelect = document.createElement("select");
      colourSelect.setAttribute("data-role", "colour");
      colourSelect.setAttribute("aria-label", "Label colour");
      colourSelect.innerHTML = buildPaletteOptions(label.colour);
      row.appendChild(colourSelect);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger";
      deleteBtn.setAttribute("data-role", "delete");
      deleteBtn.textContent = "Delete";
      row.appendChild(deleteBtn);
      labelsWrap.appendChild(row);
    });

    var addRow = document.createElement("div");
    addRow.className = "label-add-row";
    addRow.setAttribute("data-add-for", boardId);
    var addPicker = buildIconPicker(function () { return labelAddIconDrafts[boardId] || ""; }, {
      clearLabel: "No icon",
      ariaLabel: "Icon for the new label on " + board.name,
      onPick: function (picked) {
        labelAddIconDrafts[boardId] = picked;
        renderSettings();
      }
    });
    addPicker.setAttribute("data-role", "add-icon-picker");
    addRow.appendChild(addPicker);
    var addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "New label name";
    addInput.setAttribute("data-role", "add-name");
    addInput.setAttribute("aria-label", "New label name for " + board.name);
    addRow.appendChild(addInput);
    var addColour = document.createElement("select");
    addColour.setAttribute("data-role", "add-colour");
    addColour.setAttribute("aria-label", "New label colour");
    addColour.innerHTML = buildPaletteOptions(LABEL_PALETTE[(labelsForBoard(boardId).length + 1) % LABEL_PALETTE.length].id);
    var draft = addDrafts[boardId];
    if (draft) {
      addInput.value = draft.name;
      if (draft.colour) addColour.value = draft.colour;
    }
    addRow.appendChild(addColour);
    var addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "btn btn-primary";
    addButton.setAttribute("data-role", "add-label");
    addButton.textContent = "Add label";
    addRow.appendChild(addButton);
    labelsWrap.appendChild(addRow);
  }

  // Projects section: a board picker, then that board's
  // projects — the Columns pattern (issue #96), shaped like the
  // Labels section above it. Each row carries its icon picker
  // and its name, and a Delete that opens the shared project
  // delete dialog (issue #99). The add row carries its draft across
  // rebuilds the way the label add row does. A project carries
  // no colour any more (issue #94): name and icon only.
  var projectsPicker = document.getElementById("projects-board-picker");
  projectsSettingsBoardId = realId(projectsSettingsBoardId);
  if (!findBoard(projectsSettingsBoardId)) {
    projectsSettingsBoardId = state.activeBoard || (state.boards.length ? state.boards[0].id : null);
  }
  projectsPicker.innerHTML = "";
  state.boards.forEach(function (board) {
    var opt = document.createElement("option");
    opt.value = board.id;
    opt.textContent = boardIcon(board) + " " + board.name;
    projectsPicker.appendChild(opt);
  });
  projectsPicker.value = projectsSettingsBoardId || "";
  var projectsBoard = findBoard(projectsSettingsBoardId);
  var projectsWrap = document.getElementById("settings-projects");
  var projectAddDrafts = {};
  projectsWrap.querySelectorAll("[data-add-project-for]").forEach(function (row) {
    var draftName = row.querySelector("[data-role='add-name']");
    projectAddDrafts[row.getAttribute("data-add-project-for")] = {
      name: draftName ? draftName.value : ""
    };
  });
  projectsWrap.innerHTML = "";
  if (projectsBoard) {
    var board = projectsBoard;
    var boardId = board.id;

    projectsFor(boardId).forEach(function (proj) {
      var row = document.createElement("div");
      row.className = "project-row";
      row.setAttribute("data-project-row", proj.id);

      var projPicker = buildIconPicker(function () { return proj.icon || ""; }, {
        clearLabel: "No icon",
        ariaLabel: "Icon for project " + proj.name,
        onPick: function (picked) { applyIconPick(proj, picked, "/api/projects/"); }
      });
      projPicker.setAttribute("data-role", "project-icon-picker");
      row.appendChild(projPicker);

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = proj.name;
      nameInput.setAttribute("data-role", "project-name");
      nameInput.setAttribute("aria-label", "Project name");
      row.appendChild(nameInput);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger";
      deleteBtn.setAttribute("data-role", "project-delete");
      deleteBtn.textContent = "Delete";
      row.appendChild(deleteBtn);

      projectsWrap.appendChild(row);
    });

    var addRow = document.createElement("div");
    addRow.className = "project-add-row";
    addRow.setAttribute("data-add-project-for", boardId);
    var addPicker = buildIconPicker(function () { return projectAddIconDrafts[boardId] || ""; }, {
      clearLabel: "No icon",
      ariaLabel: "Icon for the new project on " + board.name,
      onPick: function (picked) {
        projectAddIconDrafts[boardId] = picked;
        renderSettings();
      }
    });
    addPicker.setAttribute("data-role", "add-icon-picker");
    addRow.appendChild(addPicker);
    var addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "New project name";
    addInput.setAttribute("data-role", "add-name");
    addInput.setAttribute("aria-label", "New project name for " + board.name);
    addRow.appendChild(addInput);
    var draft = projectAddDrafts[boardId];
    if (draft) addInput.value = draft.name;
    var addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "btn btn-primary";
    addButton.setAttribute("data-role", "add-project");
    addButton.textContent = "Add project";
    addRow.appendChild(addButton);
    projectsWrap.appendChild(addRow);
  }

  // Set Up Agent. The page manages the owner's list of keys, read
  // from the key list route: each key's name, its ending and the
  // date it was made, with rename and delete beside it. A key made
  // in this visit shows once, in full, in its own dialog — the
  // dialog functions below hold it; the page never carries it.
  document.getElementById("agent-instructions").value = agentInstructions(me.name, state.agentHost || "");
  renderKeysList();
  if (settingsPage === "setup-agent" && agentKeys === null) refreshAgentKeys();
}

// Reads the owner's key list for the Set Up Agent page. The state
// names only the newest key, so the list the page manages comes
// from the route itself, read when the page opens and again after
// every change the page makes.
var agentKeysFetchInFlight = false;
function refreshAgentKeys() {
  if (agentKeysFetchInFlight) return;
  agentKeysFetchInFlight = true;
  api("GET", "/api/me/token").then(function (res) {
    agentKeysFetchInFlight = false;
    agentKeys = (res && res.keys) || [];
    if (settingsPage === "setup-agent") renderSettings();
  }).catch(function () {
    agentKeysFetchInFlight = false;
    agentKeys = [];
    var note = document.getElementById("key-note");
    if (note && settingsPage === "setup-agent") {
      note.textContent = "Your keys could not be read. Check your connection and reopen this page.";
    }
    if (settingsPage === "setup-agent") renderSettings();
  });
}

// One row of the Set Up Agent key list per key: its name, its
// ending and its date, then Rename and Delete. Rename opens a
// field in the row (the name only; the key itself never changes),
// and Delete opens the delete dialog (issue #98) — the row itself
// never changes shape to ask.
function renderKeysList() {
  var wrap = document.getElementById("keys-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (agentKeys === null) {
    var loading = document.createElement("p");
    loading.className = "settings-note";
    loading.textContent = "Reading your keys…";
    wrap.appendChild(loading);
    return;
  }
  if (!agentKeys.length) {
    var none = document.createElement("p");
    none.className = "settings-note";
    none.textContent = "You have no keys yet.";
    wrap.appendChild(none);
    return;
  }
  agentKeys.forEach(function (key) {
    var row = document.createElement("div");
    row.className = "key-row";
    row.setAttribute("data-key-row", key.id);

    var main = document.createElement("div");
    main.className = "key-main";
    var nameLine = document.createElement("p");
    nameLine.className = "key-name";
    nameLine.textContent = key.name;
    main.appendChild(nameLine);
    var sub = document.createElement("p");
    sub.className = "key-sub";
    sub.textContent = "ending in " + key.last4 + ", made on " + formatMadeDate(key.created_at);
    main.appendChild(sub);
    row.appendChild(main);

    if (keyRenameId === key.id) {
      var renameBox = document.createElement("div");
      renameBox.className = "key-rename";
      var renameInput = document.createElement("input");
      renameInput.type = "text";
      renameInput.value = key.name;
      renameInput.setAttribute("data-role", "key-rename-input");
      renameInput.setAttribute("aria-label", "Name for the key ending in " + key.last4);
      renameBox.appendChild(renameInput);
      // The warning belongs at the naming moment (issue #61):
      // what this key already wrote keeps the name it was
      // stamped with, whatever this field becomes.
      var stampNote = document.createElement("p");
      stampNote.className = "settings-note";
      stampNote.textContent = "Work already stamped keeps the old name.";
      renameBox.appendChild(stampNote);
      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-primary";
      saveBtn.setAttribute("data-role", "key-rename-save");
      saveBtn.setAttribute("data-key-id", key.id);
      saveBtn.textContent = "Save name";
      renameBox.appendChild(saveBtn);
      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-quiet";
      cancelBtn.setAttribute("data-role", "key-rename-cancel");
      cancelBtn.textContent = "Cancel";
      renameBox.appendChild(cancelBtn);
      row.appendChild(renameBox);
    } else {
      var actions = document.createElement("div");
      actions.className = "key-actions";
      var renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "btn";
      renameBtn.setAttribute("data-role", "key-rename");
      renameBtn.setAttribute("data-key-id", key.id);
      renameBtn.textContent = "Rename";
      actions.appendChild(renameBtn);
      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger";
      deleteBtn.setAttribute("data-role", "key-delete");
      deleteBtn.setAttribute("data-key-id", key.id);
      deleteBtn.textContent = "Delete";
      actions.appendChild(deleteBtn);
      row.appendChild(actions);
    }
    wrap.appendChild(row);
  });
}

// The board-scoped Settings sections (Columns, Labels, Projects)
// open on the board the person is looking at in the main view
// (issue #96): a section's picker is a starting point for the
// visit, not a pick carried between visits.
function defaultSettingsBoardPicks(pageId) {
  var current = realId(state && state.activeBoard);
  if (!current || !findBoard(current)) return;
  if (pageId === "settings-columns-section") columnsSettingsBoardId = current;
  if (pageId === "settings-labels-section") labelsSettingsBoardId = current;
  if (pageId === "settings-projects-section") projectsSettingsBoardId = current;
}

// Opens Settings at the list. A page id opens that page directly;
// the ?settings=agent link uses that, so a person following it lands
// on the Set Up Agent page rather than the list.
function openSettings(pageId) {
  settingsPage = SETTINGS_PAGES.indexOf(pageId) !== -1 ? pageId : null;
  defaultSettingsBoardPicks(settingsPage);
  renderSettings();
  // The People section belongs to an administrator: probe its
  // route each time Settings opens — the answer decides
  // whether the nav entry stands at all. The Account page's
  // sign-in section reads its own standing the same way.
  probePeople();
  renderAccountAuth();
  var backdrop = document.getElementById("settings-backdrop");
  backdrop.hidden = false;
  backdrop.scrollTop = 0;
}

// Moves between the list and one page without leaving Settings.
function showSettingsPage(pageId) {
  settingsPage = pageId;
  defaultSettingsBoardPicks(pageId);
  renderSettings();
  document.getElementById("settings-backdrop").scrollTop = 0;
}

// The Account page stands in a view of its own (issue #90),
// opened from the header's Account button. Opening it reads
// the sign-in standing the way opening Settings did, and
// renders the shared settings fields its section carries.
function openAccount() {
  renderSettings();
  renderAccountAuth();
  var backdrop = document.getElementById("account-backdrop");
  backdrop.hidden = false;
  backdrop.scrollTop = 0;
}

function closeAccount() {
  document.getElementById("account-backdrop").hidden = true;
  closeAccountDeleteDialog();
}

function closeSettings() {
  document.getElementById("settings-backdrop").hidden = true;
  settingsPage = null;
  // The key dialogs stand down with the panel, and the shown-once
  // key leaves with them. The delete dialogs of the sweep stand
  // down with it too. The key list is read fresh the next time
  // the page opens, so it starts from null here.
  closeKeyCreatedDialog();
  closeInviteCreatedDialog();
  closePersonDeleteDialog();
  closeKeyDeleteDialog();
  closeProjectDeleteDialog();
  closeBoardDeleteDialog();
  closeLabelDeleteDialog();
  closeAccountDeleteDialog();
  agentKeys = null;
  keyRenameId = null;
}

//
// The key dialogs (issue #98). Adding a key and deleting a key
// each ask in a dialog of their own, over the Set Up Agent page
// as it stands — the shape the card delete set (issue #97). A
// new key shows once, in its dialog, with a button that copies
// it; closing the dialog clears the field, so the value stands
// nowhere on the page afterwards. A delete names its key in its
// dialog; the row it was pressed on never changes shape.

function openKeyCreatedDialog(key) {
  justCreatedKey = key;
  var field = document.getElementById("agent-key");
  field.value = key;
  document.getElementById("key-created-backdrop").hidden = false;
  field.focus();
  field.select();
  // The key is longer than the field: the selection stands for
  // copying, but the reading starts at the key's start.
  field.scrollLeft = 0;
}

function closeKeyCreatedDialog() {
  justCreatedKey = null;
  var field = document.getElementById("agent-key");
  if (field) field.value = "";
  var backdrop = document.getElementById("key-created-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function openKeyDeleteDialog(key) {
  keyDeleteTarget = key.id;
  document.getElementById("key-delete-text").textContent =
    "Delete the key “" + key.name + "” (ending in " + key.last4 +
    ")? Anything using it stops working at once. Cards whose next step it holds come back to you. " +
    "Cards and comments it already stamped keep its name." +
    " Your other keys are untouched.";
  document.getElementById("key-delete-backdrop").hidden = false;
  document.getElementById("key-delete-confirm").focus();
}

function closeKeyDeleteDialog() {
  keyDeleteTarget = null;
  var backdrop = document.getElementById("key-delete-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmKeyDelete() {
  if (!keyDeleteTarget) return;
  var keyId = keyDeleteTarget;
  closeKeyDeleteDialog();
  var note = document.getElementById("key-note");
  queueWrite(function () {
    return api("DELETE", "/api/me/token/" + encodeURIComponent(keyId));
  }).then(function () {
    if (note) note.textContent = "";
    agentKeys = null;
    refreshAgentKeys();
    renderSettings();
  }).catch(function () {
    if (note) note.textContent = "Deleting the key did not work. Check your connection and try again.";
  });
}

//
// The People page (issue #109): the administrator's surface
// on both copies, answered by the shared sign-in routes. It
// shows each account's standing — administrator or not, a
// password set or not, the passkeys they hold — and works the
// acts an administrator may do: mint an invite (a new account,
// or a password reset when the name already stands), make an
// administrator, sign a person out everywhere, remove one of
// another person's passkeys (never enrol or use one — the
// dialog says so), remove a person whole, and link unclaimed
// board sets to accounts. The route answers only for a
// signed-in administrator; the nav entry stays hidden for
// everyone else, and the routes refuse non-administrators
// themselves regardless of what this page shows.

function probePeople() {
  api("GET", "/api/auth/people").then(function (data) {
    peopleData = data;
    var btn = document.getElementById("settings-people-btn");
    if (btn) btn.hidden = false;
    renderPeople();
  }).catch(function () {
    peopleData = null;
    var btn = document.getElementById("settings-people-btn");
    if (btn) btn.hidden = true;
  });
}

function peopleNote(text) {
  var note = document.getElementById("people-note");
  if (note) note.textContent = text || "";
}

function renderPeople() {
  var wrap = document.getElementById("people-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!peopleData) return;
  (peopleData.people || []).forEach(function (person) {
    var row = document.createElement("div");
    row.className = "board-manage-row";

    var label = document.createElement("span");
    var held = (person.passkeys || []).length;
    label.textContent = person.name +
      (person.admin ? " — administrator" : "") +
      (person.you ? " (you)" : "") +
      " · " + (person.hasPassword ? "password set" : "Passkey only") +
      " · " + (held ? held + (held === 1 ? " passkey" : " passkeys") : "no passkey") +
      (person.linked ? "" : " · not linked to boards");
    row.appendChild(label);

    if (!person.admin) {
      var adminBtn = document.createElement("button");
      adminBtn.type = "button";
      adminBtn.className = "btn btn-quiet";
      adminBtn.textContent = "Make administrator";
      adminBtn.addEventListener("click", function () { makePersonAdmin(person); });
      row.appendChild(adminBtn);
    }

    var pwBtn = document.createElement("button");
    pwBtn.type = "button";
    pwBtn.className = "btn btn-quiet";
    pwBtn.textContent = person.hasPassword ? "New password link" : "Recovery link";
    pwBtn.addEventListener("click", function () { mintPersonInvite(person.name, person); });
    row.appendChild(pwBtn);

    var outBtn = document.createElement("button");
    outBtn.type = "button";
    outBtn.className = "btn btn-quiet";
    outBtn.textContent = "Sign out everywhere";
    outBtn.addEventListener("click", function () { signPersonOut(person); });
    row.appendChild(outBtn);

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", function () { openPersonDeleteDialog(person); });
    row.appendChild(removeBtn);

    wrap.appendChild(row);

    // The person's passkeys stand under their row, each with
    // its own Remove: the lost-device act an administrator may
    // do for someone else (determination 7). Enrolling or
    // using a passkey for another person is never offered —
    // it cannot be done.
    (person.passkeys || []).forEach(function (passkey) {
      var pkRow = document.createElement("div");
      pkRow.className = "board-manage-row";
      var pkLabel = document.createElement("span");
      pkLabel.textContent = "Passkey" +
        (passkey.nickname ? " — " + passkey.nickname : "") +
        (passkey.rpHome ? " · made on " + passkey.rpHome : "") +
        " · added " + new Date(passkey.createdAt).toLocaleDateString();
      pkRow.appendChild(pkLabel);
      var pkBtn = document.createElement("button");
      pkBtn.type = "button";
      pkBtn.className = "btn btn-quiet";
      pkBtn.textContent = "Remove passkey";
      pkBtn.addEventListener("click", function () {
        openPasskeyRemoveDialog(person, passkey);
      });
      pkRow.appendChild(pkBtn);
      wrap.appendChild(pkRow);
    });
  });
  renderPeopleClaims();
  renderPeopleAudit();
}

// The unclaimed board sets, inside the People page: the same
// shape-only list the waiting page shows an administrator,
// with the account picker and the link act.
function renderPeopleClaims() {
  var wrap = document.getElementById("people-unclaimed");
  if (!wrap) return;
  wrap.innerHTML = "";
  var sets = (peopleData && peopleData.unclaimed) || [];
  if (!sets.length) return;
  var heading = document.createElement("h4");
  heading.textContent = "Unlinked board sets";
  wrap.appendChild(heading);
  var note = document.createElement("p");
  note.className = "settings-note";
  note.textContent = "Link a set to give an account its boards, as they stand — nothing moves.";
  wrap.appendChild(note);
  sets.forEach(function (set) {
    var row = document.createElement("div");
    row.className = "board-manage-row";
    var label = document.createElement("span");
    var changed = set.lastChangeAt ? new Date(set.lastChangeAt).toLocaleString() : "never";
    label.textContent = (set.boards.length ? set.boards.join(", ") : "No boards") +
      " — " + set.cardCount + (set.cardCount === 1 ? " card" : " cards") +
      ", last changed " + changed + ".";
    row.appendChild(label);
    var pick = document.createElement("select");
    (peopleData.people || []).forEach(function (person) {
      var opt = document.createElement("option");
      opt.value = person.key;
      opt.textContent = person.name;
      pick.appendChild(opt);
    });
    row.appendChild(pick);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Link to this account";
    btn.addEventListener("click", function () {
      peopleNote("");
      api("POST", "/api/auth/claim", { owner_id: set.ownerId, account_key: pick.value })
        .then(function () { probePeople(); })
        .catch(function (err) {
          peopleNote(err.message || "Linking did not work. Try again.");
        });
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}

// The audit trail's act codes in plain words (issue #148):
// the record stores codes, and this list is where a lay
// reader meets them, so they read as what happened. A code
// the map does not know reads with its dashes as spaces —
// still words, never a raw code. No row ever carries
// credential material: the writers store a passkey's
// nickname or nothing, never a credential fragment.
var AUDIT_ACT_WORDS = {
  "first-account": "First account created",
  "account-created": "Account created",
  "account-erased": "Account deleted",
  "person-removed": "Person removed",
  "password-reset": "Password reset",
  "password-added": "Password added",
  "password-changed": "Password changed",
  "password-removed": "Password removed",
  "passkey-added": "Passkey added",
  "passkey-removed": "Passkey removed",
  "passkey-recovery": "New passkey enrolled through a recovery link",
  "invite-minted": "Invite made",
  "admin-granted": "Made an administrator",
  "admin-removed": "Administrator removed",
  "claim": "Board set linked",
  "claim-reassigned": "Board set linked from another account",
  "sign-out-everywhere": "Signed out everywhere",
};

function auditActWords(act) {
  if (AUDIT_ACT_WORDS[act]) return AUDIT_ACT_WORDS[act];
  return String(act || "").replace(/-/g, " ");
}

// The recent sign-in record: who did what at the door, newest
// first. A name that no longer resolves was a removed account.
function renderPeopleAudit() {
  var wrap = document.getElementById("people-audit");
  if (!wrap) return;
  wrap.innerHTML = "";
  var rows = (peopleData && peopleData.audit) || [];
  if (!rows.length) return;
  var heading = document.createElement("h4");
  heading.textContent = "Recent sign-in activity";
  wrap.appendChild(heading);
  var list = document.createElement("ul");
  list.className = "settings-note";
  rows.forEach(function (row) {
    var item = document.createElement("li");
    item.textContent = new Date(row.at).toLocaleString() + " — " +
      (row.actor || "Someone") + " · " + auditActWords(row.act) +
      (row.target ? " · " + row.target : "") +
      (row.detail ? " · " + row.detail : "");
    list.appendChild(item);
  });
  wrap.appendChild(list);
}

function mintPersonInvite(name, person) {
  peopleNote("");
  if (!person && peopleData) {
    (peopleData.people || []).forEach(function (p) {
      if (p.name.trim().toLowerCase() === String(name).trim().toLowerCase()) person = p;
    });
  }
  api("POST", "/api/auth/invites", { name: name }).then(function (data) {
    var input = document.getElementById("people-invite-name");
    if (input && input.value.trim() === name) input.value = "";
    openInviteCreatedDialog(data, person);
  }).catch(function (err) {
    peopleNote(err.message || "Making the invite did not work. Try again.");
  });
}

function makePersonAdmin(person) {
  peopleNote("");
  api("POST", "/api/auth/admin", { account_key: person.key, admin: true }).then(function () {
    probePeople();
  }).catch(function (err) {
    peopleNote(err.message || "That did not work. Try again.");
  });
}

function signPersonOut(person) {
  peopleNote("");
  api("POST", "/api/auth/people/" + encodeURIComponent(person.key) + "/signout", {})
    .then(function () {
      peopleNote(person.name + " is signed out everywhere.");
    })
    .catch(function (err) {
      peopleNote(err.message || "That did not work. Try again.");
    });
}

function openInviteCreatedDialog(data, person) {
  var text;
  if (data.reset && person && !person.hasPassword) {
    text = "A recovery link for " + data.name + ". That account signs in with " +
      "passkeys alone, so the link enrols a new passkey — its boards stay as " +
      "they are, and its standing passkeys are not touched unless the person " +
      "picks the start-fresh choice on the page.";
  } else if (data.reset) {
    text = "A new password link for " + data.name + ". Spending it sets a new " +
      "password for that account — its boards stay as they are, and its " +
      "passkeys are not touched: a passkey comes off only when the person " +
      "removes it, you remove it by name here, or the person picks the " +
      "start-fresh choice on the form.";
  } else {
    text = "An invite for " + data.name + ". They set their own password at " +
      "the end of the link — or enrol a passkey instead — and their account " +
      "stands from then on.";
  }
  document.getElementById("invite-created-text").textContent = text;
  var field = document.getElementById("invite-link");
  field.value = data.link;
  document.getElementById("invite-created-backdrop").hidden = false;
  field.focus();
  field.select();
  field.scrollLeft = 0;
}

function closeInviteCreatedDialog() {
  var field = document.getElementById("invite-link");
  if (field) field.value = "";
  var backdrop = document.getElementById("invite-created-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function openPersonDeleteDialog(person) {
  personToRemove = person;
  document.getElementById("person-delete-text").textContent =
    "Remove " + person.name + "? Their account, their boards and everything on them, " +
    "their passkeys and their keys are erased. No undo.";
  document.getElementById("person-delete-backdrop").hidden = false;
  document.getElementById("person-delete-confirm").focus();
}

function closePersonDeleteDialog() {
  personToRemove = null;
  var backdrop = document.getElementById("person-delete-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmPersonDelete() {
  if (!personToRemove) return;
  var person = personToRemove;
  closePersonDeleteDialog();
  peopleNote("");
  api("DELETE", "/api/auth/people/" + encodeURIComponent(person.key)).then(function () {
    probePeople();
  }).catch(function (err) {
    peopleNote(err.message || "Removing them did not work. Try again.");
  });
}

function openPasskeyRemoveDialog(person, passkey) {
  passkeyToRemove = {
    personKey: person.key, personName: person.name,
    credId: passkey.id, nickname: passkey.nickname || ""
  };
  var held = (person.passkeys || []).length;
  var shape;
  if (!person.hasPassword && held <= 1) {
    // The last passkey on a passwordless account: the
    // removal is refused (amendment A.9, edge 1), and the
    // dialog states the order from this side — adding a
    // password is the person's own act, and until then the
    // passkey stands.
    shape = "That is their only passkey, and their account has no password. " +
      "The person adds a password first — until then, the passkey stands, " +
      "and removing it is refused. ";
  } else if (!person.hasPassword) {
    shape = "They sign in with their passkeys alone, and their other passkeys still stand. ";
  } else {
    shape = "Their password still stands, and they can enrol a passkey again themselves. ";
  }
  document.getElementById("passkey-remove-text").textContent =
    "Remove " + person.name + "'s passkey" +
    (passkey.nickname ? " (" + passkey.nickname + ")" : "") +
    "? That device stops signing them in. " + shape +
    "You can remove a passkey for someone else, but you can never add one for them or sign in as them.";
  document.getElementById("passkey-remove-backdrop").hidden = false;
  document.getElementById("passkey-remove-confirm").focus();
}

function closePasskeyRemoveDialog() {
  passkeyToRemove = null;
  var backdrop = document.getElementById("passkey-remove-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmPasskeyRemove() {
  if (!passkeyToRemove) return;
  var armed = passkeyToRemove;
  closePasskeyRemoveDialog();
  peopleNote("");
  api("DELETE", "/api/auth/people/" + encodeURIComponent(armed.personKey) +
    "/passkeys/" + encodeURIComponent(armed.credId)).then(function () {
    probePeople();
  }).catch(function (err) {
    peopleNote(err.message || "Removing the passkey did not work. Try again.");
  });
}

//
// The Account page's sign-in section (issue #109): the person's
// own passkeys, their password change, and signing out
// everywhere. A passkey enrolment and a password change are
// guarded acts — they take a fresh proof — and a refusal
// naming the step-up it wants opens the proof panel, which
// collects the proof and retries the act once. Enrolling the
// first passkey takes any fresh proof; once one stands,
// enrolling another takes a passkey proof, so a password alone
// cannot grow the passkey set (determination 2).

// The browser's base64url helpers for the WebAuthn ceremony:
// the ceremony's bytes ride as base64url in JSON.
function b64uToBuf(text) {
  var b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bufToB64u(buf) {
  var bin = "";
  var bytes = new Uint8Array(buf);
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authNote(text) {
  var note = document.getElementById("account-auth-note");
  if (note) note.textContent = text || "";
}

// Stands the Account page's sign-in section up or down as
// one piece (issue #110): when the sign-in routes refuse this
// caller, every act in the section — adding or removing a
// passkey, proving, changing the password, signing out
// everywhere — is disabled where it stands, so nothing on
// the page invites a click that cannot work; when the caller
// is an account, the section stands live again.
function setAccountSigninEnabled(enabled) {
  var section = document.getElementById("account-signin");
  if (!section) return;
  var fields = section.querySelectorAll("input, button");
  for (var i = 0; i < fields.length; i++) fields[i].disabled = !enabled;
}

// Passkeys run only where the browser sits in a secure
// context — HTTPS, or a localhost address (issue #113). At an
// ordinary HTTP address the browser offers no passkey
// machinery at all, so this page offers no passkey act there:
// the line below stands in their place and names the address
// as the reason. The sign-in page prints the same line
// (worker/auth.js carries its own copy).
var PASSKEY_OFF_LINE = "Passkeys need a secure address (HTTPS). " +
  "This copy is at an ordinary HTTP address, so passkeys are off here. " +
  "Your password works as usual.";

function passkeysCanRun() {
  return !!window.isSecureContext;
}

// Stands the gate on the Account page: where passkeys cannot
// run, the passkey add act (its nickname field and button)
// is hidden and the line stands in its place. Passkeys
// already made still list above and can be removed — removal
// is a plain call, not a ceremony.
function applyPasskeyGate() {
  if (passkeysCanRun()) return;
  var nicknameLabel = document.querySelector('label[for="account-passkey-nickname"]');
  if (nicknameLabel) nicknameLabel.hidden = true;
  var addBtn = document.getElementById("account-passkey-add");
  if (addBtn && addBtn.parentElement) addBtn.parentElement.hidden = true;
  var off = document.getElementById("account-passkey-off");
  if (off) {
    off.textContent = PASSKEY_OFF_LINE;
    off.hidden = false;
  }
}

// The account's own standing, for the Account page: its
// passkeys and whether it holds a password.
function renderAccountAuth() {
  api("GET", "/api/auth/me").then(function (me) {
    accountAuth = me;
    setAccountSigninEnabled(true);
    renderAccountPasskeys(me);
    renderAccountPassword(me);
    applyPasskeyGate();
  }).catch(function () {
    // A caller the sign-in routes refuse — the transition
    // door's caller — leaves the section standing as the page
    // wrote it, its acts disabled, with the note saying why.
    accountAuth = null;
    var wrap = document.getElementById("account-passkeys-list");
    if (wrap) wrap.innerHTML = "";
    setAccountSigninEnabled(false);
    authNote("Sign-in settings are not available for this sign-in.");
  });
}

// The password section's two states (issue #122, amendment
// A.4): a password stands — the change form as built, with
// the drop offered beneath it while at least one passkey
// stands and the address can run the tap that proves it; or
// no password stands — the section reads as a state, not a
// gap, with Add a password as its one act.
function renderAccountPassword(me) {
  var heading = document.getElementById("account-password-heading");
  var state = document.getElementById("account-password-state");
  var btn = document.getElementById("account-password-btn");
  var drop = document.getElementById("account-password-drop");
  if (!heading || !btn) return;
  // A copy whose sign-in takes no passwords offers no password
  // setting at all (issue #46): the whole section stands down.
  var section = document.getElementById("account-password-section");
  if (section) section.hidden = !!(me && me.passwordsAllowed === false);
  var has = !!(me && me.hasPassword);
  heading.textContent = has ? "Change password" : "Password";
  if (state) state.hidden = has;
  btn.textContent = has ? "Change password" : "Add a password";
  if (drop) {
    drop.hidden = !(has && me && (me.passkeys || []).length > 0 && passkeysCanRun());
  }
}

// The drop's dialog (amendment A.3): the facts stand in it
// before the confirm does — signing in with passkeys alone
// from then on, the recovery link as the only way back, the
// address warning, and, when the caller is the copy's only
// administrator, that their own recovery then sits at the
// operator's layer, outside the app.
function openPasswordDropDialog() {
  var me = accountAuth;
  var facts = [
    "From then on, you sign in with your passkeys alone.",
    "If every passkey is lost, the way back is a recovery link from the administrator or the person who runs this copy — no password road remains.",
    "If this copy's address changes, the passkeys stop working, so a password is worth keeping if a change of address is planned."
  ];
  var finish = function () {
    var box = document.getElementById("password-drop-text");
    if (box) {
      box.innerHTML = "";
      facts.forEach(function (fact) {
        var p = document.createElement("p");
        p.textContent = fact;
        box.appendChild(p);
      });
    }
    var backdrop = document.getElementById("password-drop-backdrop");
    if (backdrop) backdrop.hidden = false;
    var confirm = document.getElementById("password-drop-confirm");
    if (confirm) confirm.focus();
  };
  if (me && me.admin) {
    api("GET", "/api/auth/people").then(function (data) {
      var admins = (data.people || []).filter(function (p) { return p.admin; });
      if (admins.length <= 1) {
        facts.push("You are this copy's only administrator. If you then lose every passkey, your way back sits outside the app: a command on the machine at home, or the deployment credential on a hosted copy.");
      }
      finish();
    }).catch(function () { finish(); });
  } else {
    finish();
  }
}

function closePasswordDropDialog() {
  var backdrop = document.getElementById("password-drop-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmPasswordDrop() {
  closePasswordDropDialog();
  authNote("");
  runGuarded(function () {
    return api("POST", "/api/auth/password/remove", {}).then(function () {
      authNote("Password removed. This account now signs in with passkeys alone.");
    });
  }, function (err) {
    authNote(err.message || "Removing the password did not work. Try again.");
  }).then(function () {
    renderAccountAuth();
  }).catch(function () { /* the note above says why */ });
}

function renderAccountPasskeys(me) {
  var wrap = document.getElementById("account-passkeys-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  var passkeys = (me && me.passkeys) || [];
  if (!passkeys.length) {
    var none = document.createElement("p");
    none.className = "settings-note";
    none.textContent = "No passkeys yet.";
    wrap.appendChild(none);
    return;
  }
  passkeys.forEach(function (passkey) {
    var row = document.createElement("div");
    row.className = "board-manage-row";
    var label = document.createElement("span");
    label.textContent = "Passkey" +
      (passkey.nickname ? " — " + passkey.nickname : "") +
      (passkey.rpHome ? " · made on " + passkey.rpHome : "") +
      " · added " + new Date(passkey.createdAt).toLocaleDateString() +
      (passkey.lastUsedAt ? " · last used " + new Date(passkey.lastUsedAt).toLocaleDateString() : "");
    row.appendChild(label);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-quiet";
    btn.textContent = "Remove";
    btn.addEventListener("click", function () {
      openOwnPasskeyRemoveDialog(passkey);
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}

// Removing your own passkey asks first (issue #136): the
// dialog names the passkey and what stands after, in the
// shapes the Admin page's dialog uses for another person's.
// The last passkey on a passwordless account still refuses —
// the dialog states the order, and the server's own words
// land in the note if the press goes ahead anyway.
function openOwnPasskeyRemoveDialog(passkey) {
  ownPasskeyToRemove = passkey;
  authNote("");
  var me = accountAuth;
  var held = me && me.passkeys ? me.passkeys.length : 1;
  var hasPassword = !!(me && me.hasPassword);
  var shape;
  if (!hasPassword && held <= 1) {
    shape = "That is your only passkey, and your account has no password. " +
      "Add a password first — until then, the passkey stands, " +
      "and removing it is refused. ";
  } else if (!hasPassword) {
    shape = "You sign in with your passkeys alone, and your other passkeys still stand. ";
  } else {
    shape = "Your password still stands, and you can enrol a passkey again yourself. ";
  }
  document.getElementById("own-passkey-remove-text").textContent =
    "Remove your passkey" +
    (passkey.nickname ? " (" + passkey.nickname + ")" : "") +
    "? That device stops signing you in. " + shape.trim();
  document.getElementById("own-passkey-remove-backdrop").hidden = false;
  document.getElementById("own-passkey-remove-confirm").focus();
}

function closeOwnPasskeyRemoveDialog() {
  ownPasskeyToRemove = null;
  var backdrop = document.getElementById("own-passkey-remove-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function confirmOwnPasskeyRemove() {
  if (!ownPasskeyToRemove) return;
  var passkey = ownPasskeyToRemove;
  closeOwnPasskeyRemoveDialog();
  authNote("");
  api("DELETE", "/api/auth/passkeys/" + encodeURIComponent(passkey.id))
    .then(function () { renderAccountAuth(); })
    .catch(function (err) {
      authNote(err.message || "Removing the passkey did not work. Try again.");
    });
}

// A guarded act, run with the step-up machinery: on a refusal
// naming a step-up, the proof panel opens for that proof, and
// the act runs once more after the proof lands. Anything else
// fails the way it failed.
function runGuarded(act, onError) {
  return act().catch(function (err) {
    if (err && err.status === 403 && err.data && err.data.stepUp) {
      pendingGuarded = act;
      showProofPanel(err.data.stepUp);
      return;
    }
    if (onError) onError(err);
    throw err;
  });
}

function showProofPanel(needs) {
  var panel = document.getElementById("account-proof-panel");
  if (!panel) return;
  var text = document.getElementById("account-proof-text");
  if (text) {
    text.textContent = needs === "passkey"
      ? "This account holds a passkey, so this act takes a passkey tap first."
      : (passkeysCanRun()
        ? "That act takes a fresh proof first: type your password, or tap a passkey."
        : "That act takes a fresh proof first: type your password.");
  }
  var pwBtn = document.getElementById("account-proof-password-btn");
  if (pwBtn) pwBtn.hidden = needs === "passkey";
  var pwLabel = document.querySelector('label[for="account-proof-password"]');
  if (pwLabel) pwLabel.hidden = needs === "passkey";
  // The passkey proof act is gated like every passkey act
  // (issue #113): where no ceremony can run the button is
  // hidden and the line stands under the panel's buttons.
  var pkBtn = document.getElementById("account-proof-passkey-btn");
  if (pkBtn) pkBtn.hidden = !passkeysCanRun();
  var off = document.getElementById("account-proof-off");
  if (off) {
    off.textContent = passkeysCanRun() ? "" : PASSKEY_OFF_LINE;
    off.hidden = passkeysCanRun();
  }
  panel.hidden = false;
}

function hideProofPanel() {
  var panel = document.getElementById("account-proof-panel");
  if (panel) panel.hidden = true;
  var pwInput = document.getElementById("account-proof-password");
  if (pwInput) pwInput.value = "";
}

function finishProof() {
  hideProofPanel();
  if (pendingGuarded) {
    var act = pendingGuarded;
    pendingGuarded = null;
    act().then(function () {
      renderAccountAuth();
    }).catch(function (err) {
      authNote(err.message || "That did not work. Try again.");
    });
  }
}

function proofByPassword() {
  var input = document.getElementById("account-proof-password");
  var password = input ? input.value : "";
  authNote("");
  api("POST", "/api/auth/proof/password", { password: password }).then(function () {
    finishProof();
  }).catch(function (err) {
    authNote(err.message || "That proof did not work. Try again.");
  });
}

function proofByPasskey() {
  if (!passkeysCanRun()) {
    // The address, not the browser: the line names it.
    authNote(PASSKEY_OFF_LINE);
    return;
  }
  authNote("");
  api("POST", "/api/auth/proof/passkey/options", {}).then(function (options) {
    if (!window.PublicKeyCredential) throw new Error("This browser has no passkey support.");
    var request = {
      challenge: b64uToBuf(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: "required",
      allowCredentials: (options.allowCredentials || []).map(function (cred) {
        return { id: b64uToBuf(cred.id), type: cred.type };
      })
    };
    return navigator.credentials.get({ publicKey: request });
  }).then(function (assertion) {
    var response = {
      id: bufToB64u(assertion.rawId),
      type: assertion.type,
      response: {
        clientDataJSON: bufToB64u(assertion.response.clientDataJSON),
        authenticatorData: bufToB64u(assertion.response.authenticatorData),
        signature: bufToB64u(assertion.response.signature),
        userHandle: assertion.response.userHandle
          ? bufToB64u(assertion.response.userHandle) : null
      }
    };
    return api("POST", "/api/auth/proof/passkey/verify", { response: response });
  }).then(function () {
    finishProof();
  }).catch(function (err) {
    authNote(err.message || "That passkey tap did not prove you. Try again.");
  });
}

function addPasskey() {
  if (!passkeysCanRun()) {
    // The address, not the browser: the line names it. The
    // no-support note below is only for a browser that
    // genuinely lacks the machinery at a secure address.
    authNote(PASSKEY_OFF_LINE);
    return;
  }
  if (!window.PublicKeyCredential) {
    authNote("This browser has no passkey support.");
    return;
  }
  authNote("");
  var nicknameInput = document.getElementById("account-passkey-nickname");
  var nickname = nicknameInput ? nicknameInput.value.trim() : "";
  var act = function () {
    return api("POST", "/api/auth/passkeys/options", {}).then(function (options) {
      var request = {
        challenge: b64uToBuf(options.challenge),
        rp: options.rp,
        user: {
          id: b64uToBuf(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName
        },
        pubKeyCredParams: options.pubKeyCredParams,
        authenticatorSelection: options.authenticatorSelection,
        attestation: "none",
        timeout: options.timeout,
        excludeCredentials: (options.excludeCredentials || []).map(function (cred) {
          return { id: b64uToBuf(cred.id), type: cred.type };
        })
      };
      return navigator.credentials.create({ publicKey: request });
    }).then(function (credential) {
      var response = {
        id: bufToB64u(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: bufToB64u(credential.response.clientDataJSON),
          attestationObject: bufToB64u(credential.response.attestationObject),
          transports: credential.response.getTransports
            ? credential.response.getTransports() : []
        }
      };
      return api("POST", "/api/auth/passkeys", { response: response, nickname: nickname });
    });
  };
  runGuarded(act, function (err) {
    authNote(err.message || "Adding the passkey did not work. Try again.");
  }).then(function () {
    if (nicknameInput) nicknameInput.value = "";
    renderAccountAuth();
  }).catch(function () { /* the note above says why */ });
}

// Changing the password is a guarded act like enrolling a
// passkey (issue #114): the form carries only the new
// password and its confirmation, and the fresh proof the act
// needs comes through the proof panel — the form has no
// current-password field of its own to duplicate it. The
// server's requirement stands exactly as designed: a fresh
// proof inside its window, or the refusal names the step-up
// and runGuarded collects it.
function changeOwnPassword() {
  authNote("");
  var newInput = document.getElementById("account-password-new");
  var confirmInput = document.getElementById("account-password-confirm");
  var next = newInput ? newInput.value : "";
  var confirm = confirmInput ? confirmInput.value : "";
  if (next !== confirm) {
    authNote("The two new passwords did not match.");
    return;
  }
  // A guarded act (issue #114): the form carries no
  // current-password field — on a step-up refusal the proof
  // panel opens, the proof lands, and this act runs again.
  // The success effects ride inside the act, so they land
  // only when the change itself does.
  runGuarded(function () {
    return api("POST", "/api/auth/password", { new_password: next }).then(function () {
      if (newInput) newInput.value = "";
      if (confirmInput) confirmInput.value = "";
      authNote(accountAuth && !accountAuth.hasPassword
        ? "Password added. Other sign-ins are signed out."
        : "Password changed. Other sign-ins are signed out.");
    });
  }, function (err) {
    authNote(err.message || "Changing the password did not work. Try again.");
  }).then(function () {
    // The section re-reads the account: an add-back turns the
    // state line off and the button back to Change password,
    // and the drop stands offered again (issue #122).
    renderAccountAuth();
  }).catch(function () { /* the note above says why */ });
}

function signOutEverywhere() {
  authNote("");
  api("POST", "/api/auth/signout-everywhere", {}).then(function () {
    authNote("Signed out everywhere else. This browser stays signed in.");
  }).catch(function (err) {
    authNote(err.message || "That did not work. Try again.");
  });
}

function copyFieldText(text, button) {
  function done() {
    if (!button) return;
    var old = button.textContent;
    button.textContent = "Copied";
    setTimeout(function () { button.textContent = old; }, 1400);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () { done(); });
  } else {
    done();
  }
}

// --- Wiring ---

// Boot takes its elements by name and tolerates any of them
// missing. A page from an older build — the shape a stale cached
// copy leaves behind — can lack an element this build expects,
// and a missing element must never be the thing that stops the
// boards from loading: the boot wires what it finds and paints
// what it can.
function byId(id) {
  return document.getElementById(id);
}

function wire(id, event, handler) {
  var el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
  return el;
}

function init() {
  // Board switcher. The tabs are rebuilt on every render, so one
  // delegated listener on the nav handles the clicks. Switching
  // boards restores the board as this device left it.
  wire("board-switcher", "click", function (ev) {
    if (!state) return;
    var tab = ev.target.closest ? ev.target.closest(".board-tab") : null;
    if (!tab) return;
    var boardId = tab.getAttribute("data-board");
    // The release of a fired press-and-hold lands here; it
    // belongs to the press, not to the switch.
    if (pressClickSwallowed("board", boardId)) return;
    // The second click of a double-click opens the rename
    // editor on the tab. It is read off the click's own count
    // rather than a dblclick event: the switch below rebuilds
    // the tab, and a rebuilt node is not the node the first
    // click landed on, which is where a dblclick event looks.
    // The first click of one never switches either: a mouse or
    // pen click waits out the double-click window (see
    // deferPressApply), and the second click cancels the wait
    // and opens the editor.
    if (ev.detail === 2) {
      cancelPressApply("board:" + boardId);
      openPressEditor("board", boardId, tab);
      return;
    }
    var applySwitch = function () {
      state.activeBoard = boardId;
      // Switching boards leaves the overview: it stood showing
      // the board that was on screen before.
      overviewOpen = false;
      applyBoardView(boardId);
      render();
    };
    if (clickAppliesAtOnce(ev)) applySwitch();
    else deferPressApply("board:" + boardId, applySwitch);
  });

  // The Move board dialog (issue #163): the editor's button
  // opens it, its board pick re-aims the column and project
  // picks, and its confirm makes the move.
  wire("editor-move-board", "click", function () { openMoveBoardDialog(); });
  wire("move-board-cancel", "click", function () { dismissMoveBoardDialog(); });
  wire("move-board-confirm", "click", function () { confirmMoveBoard(); });
  wire("move-board-board", "change", function () {
    var card = moveBoardCardId ? findCard(moveBoardCardId) : null;
    if (card) aimMoveBoardPicks(card);
  });

  // Add a project on the current board. It paints at once with a
  // temporary id and the server's id swaps in behind it. The icon
  // picker beside the name field holds its pick in a draft, and
  // the pick rides the create call.
  var projectPicker = mountIconPicker(document.getElementById("project-icon-mount"),
    function () { return projectAddIconDraft; }, {
      clearLabel: "No icon",
      ariaLabel: "Icon for the new project",
      onPick: function (picked) {
        projectAddIconDraft = picked;
        projectPicker.refresh();
      }
    });
  var addForm = byId("project-add-form");
  if (addForm) addForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!state) return;
    var input = document.getElementById("project-name-input");
    var name = input.value.trim();
    if (!name) return;
    var project = {
      id: tempId("proj"),
      boardId: state.activeBoard,
      name: name,
      icon: projectAddIconDraft
    };
    state.projects.push(project);
    input.value = "";
    projectAddIconDraft = "";
    projectPicker.refresh();
    addForm.hidden = true;
    render();
    saveQueued(function () {
      return api("POST", "/api/projects", { board_id: realId(project.boardId), name: project.name, icon: project.icon });
    }, function (res) {
      var oldId = project.id;
      idAliases[oldId] = res.project.id;
      project.id = res.project.id;
      if (state.projectFilter === oldId) state.projectFilter = res.project.id;
      // A card made a moment ago can already carry the temporary
      // id (a column's plus starts a card on the filtered project).
      state.cards.forEach(function (card) {
        if (card.projectId === oldId) card.projectId = res.project.id;
      });
      // A rename that landed while the create was in flight is
      // local only. Send it now that the project has its real
      // id, the way a board's create follow-up sends its drift.
      if (project.name !== res.project.name) {
        var driftName = project.name;
        saveQueued(function () {
          return api("PATCH", "/api/projects/" + encodeURIComponent(project.id), { name: driftName });
        }).catch(function () { /* reloadState already ran */ });
      }
      render();
    }).catch(function () { /* reloadState already ran */ });
  });
  wire("project-add-cancel", "click", function () {
    document.getElementById("project-name-input").value = "";
    projectAddIconDraft = "";
    projectPicker.refresh();
    addForm.hidden = true;
  });

  // Adding a card lives at each column's foot: render() wires
  // every column's plus to openNewCard with that column.

  // Editor fields commit on their own. Title and Notes commit when
  // the field loses focus. Enter in the Title field blurs it, which
  // commits and leaves the editor open. The other fields commit the
  // moment they change. Closing the editor flushes anything still
  // uncommitted.
  wire("field-title", "blur", commitEditorFields);
  wire("field-notes", "blur", commitEditorFields);
  wire("field-title", "keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      this.blur();
    }
  });
  // A tick in the Labels list puts that label on the card or lifts
  // it off, at once: the card's list is updated first, then the
  // commit sends it, the way every other field commits on change.
  wire("field-labels", "change", function (ev) {
    var row = ev.target.closest ? ev.target.closest("[data-label-tick]") : null;
    if (!row || ev.target.getAttribute("data-role") !== "label-tick-box") return;
    var card = findCard(editingId);
    if (!card) return;
    var labelId = row.getAttribute("data-label-tick");
    var worn = (card.labels || []).slice();
    if (ev.target.checked && worn.indexOf(labelId) === -1) worn.push(labelId);
    if (!ev.target.checked) worn = worn.filter(function (id) { return id !== labelId; });
    card.labels = worn;
    commitEditorFields();
  });
  wire("field-project", "change", commitEditorFields);
  wire("field-due", "change", commitEditorFields);
  // The Important toggle applies the moment it changes, like the
  // dropdowns and the due date: commitEditorFields reads it with
  // the other fields, so it also rides a new card's create.
  wire("field-important", "change", commitEditorFields);

  // The editor's checklist. Ticking a step commits the moment it
  // changes, Remove acts at once, the Add row creates a step the
  // moment it is used, and a step's grip drags it to a new place —
  // the same save-themselves rules as every other field. A step's
  // text stands as wrapped text; tapping it swaps in the editing
  // field, and the rename commits when the field settles, by
  // change or by losing focus. Enter in a step field must never
  // reach the form (Enter there closes the editor): in the Add
  // row it adds the step, and in a step's field it settles the
  // rename by blurring, which is what commits it.
  var checklistList = byId("checklist-list");
  function stepFromRow(row) {
    var card = findCard(editingId);
    if (!card || !row) return { card: null, step: null };
    var id = row.getAttribute("data-step-row");
    var found = null;
    (card.steps || []).forEach(function (s) { if (s.id === id) found = s; });
    return { card: card, step: found };
  }
  // Tapping a step's text swaps the wrapped text for the editing
  // field, seeded with the step as it stands.
  function beginStepEdit(view) {
    var found = stepFromRow(view.closest("[data-step-row]"));
    if (!found.step) return;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "step-edit";
    input.value = found.step.text;
    input.setAttribute("data-role", "step-text");
    input.setAttribute("aria-label", "Step text");
    view.replaceWith(input);
    input.focus();
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch (e) { /* a field that cannot place its caret still edits */ }
  }
  // The editing field settles: a name that changed commits, an
  // emptied or cancelled one leaves the step as it was, and
  // either way the row goes back to wrapped text showing the step
  // as it stands. Settles on focusout; when the change event gets
  // there first it has already committed, and this finds nothing
  // left to change.
  function settleStepEdit(input) {
    var row = input.closest("[data-step-row]");
    if (!row) return;
    var found = stepFromRow(row);
    if (!found.step) return;
    if (!input._stepEditCancelled) {
      var clean = input.value.trim();
      if (clean && clean !== found.step.text) {
        found.step.text = clean;
        render();
        queueStepPatch(found.card, found.step);
      }
    }
    input.replaceWith(buildStepText(found.step));
  }
  if (checklistList) checklistList.addEventListener("change", function (ev) {
    var role = ev.target.getAttribute("data-role");
    if (role !== "step-done" && role !== "step-text") return;
    var found = stepFromRow(ev.target.closest("[data-step-row]"));
    if (!found.step) return;
    if (role === "step-done") {
      found.step.done = ev.target.checked;
      var row = ev.target.closest("[data-step-row]");
      if (row) row.classList.toggle("done", found.step.done);
      render();
      queueStepPatch(found.card, found.step);
    } else {
      var clean = ev.target.value.trim();
      if (!clean) {
        ev.target.value = found.step.text;
        return;
      }
      if (clean === found.step.text) return;
      found.step.text = clean;
      render();
      queueStepPatch(found.card, found.step);
    }
  });
  if (checklistList) checklistList.addEventListener("click", function (ev) {
    var role = ev.target.getAttribute("data-role");
    if (role === "step-text" && ev.target.tagName !== "INPUT") {
      beginStepEdit(ev.target);
      return;
    }
    if (role !== "step-remove") return;
    var found = stepFromRow(ev.target.closest("[data-step-row]"));
    if (!found.step) return;
    found.card.steps = found.card.steps.filter(function (s) { return s.id !== found.step.id; });
    renderChecklist();
    render();
    queueStepDelete(found.card, found.step);
  });
  if (checklistList) checklistList.addEventListener("focusout", function (ev) {
    if (ev.target.tagName === "INPUT" && ev.target.getAttribute("data-role") === "step-text") {
      settleStepEdit(ev.target);
    }
  });
  if (checklistList) checklistList.addEventListener("pointerdown", function (ev) {
    var grip = ev.target.closest ? ev.target.closest('[data-role="step-grip"]') : null;
    if (!grip) return;
    var row = grip.closest("[data-step-row]");
    var found = stepFromRow(row);
    if (!found.step) return;
    watchStepPointer(ev, found.card, found.step, row);
  });
  if (checklistList) checklistList.addEventListener("keydown", function (ev) {
    if (ev.target.getAttribute("data-role") !== "step-text") return;
    if (ev.target.tagName === "INPUT") {
      if (ev.key === "Enter") {
        ev.preventDefault();
        ev.target.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.target._stepEditCancelled = true;
        ev.target.blur();
      }
    } else if (ev.key === "Enter" || ev.key === "F2") {
      ev.preventDefault();
      beginStepEdit(ev.target);
    }
  });
  wire("checklist-add-btn", "click", function () {
    addStepFromInput();
  });
  wire("checklist-add-input", "keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      addStepFromInput();
    }
  });

  // The editor's links. Remove acts at once, and the Add row adds
  // the moment it is used — the same save-themselves rules as every
  // other field. Enter in either add field adds the link and must
  // never reach the form (Enter there closes the editor). Following
  // a row's link is the anchor's own doing: a new tab, leaving the
  // editor as it stands.
  var linksList = byId("links-list");
  if (linksList) linksList.addEventListener("click", function (ev) {
    if (ev.target.getAttribute("data-role") !== "link-remove") return;
    var card = findCard(editingId);
    if (!card) return;
    var row = ev.target.closest("[data-link-row]");
    if (!row) return;
    var rowId = row.getAttribute("data-link-row");
    var found = null;
    (card.links || []).forEach(function (l) { if (l.id === rowId) found = l; });
    if (!found) return;
    card.links = card.links.filter(function (l) { return l.id !== found.id; });
    renderLinks();
    render();
    queueLinkDelete(card, found);
  });
  wire("link-add-btn", "click", function () {
    addLinkFromInputs();
  });
  ["link-add-url", "link-add-name"].forEach(function (inputId) {
    document.getElementById(inputId).addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        addLinkFromInputs();
      }
    });
  });

  // The editor's comments. Remove acts at once, and the Add
  // button adds the moment it is used — the same save-themselves
  // rules as the checklist and the links. The add field is a
  // textarea, so Enter there is a new line in the comment, not
  // a send.
  var commentsList = byId("comments-list");
  if (commentsList) commentsList.addEventListener("click", function (ev) {
    if (ev.target.getAttribute("data-role") !== "comment-remove") return;
    var card = findCard(editingId);
    if (!card) return;
    var row = ev.target.closest("[data-comment-row]");
    if (!row) return;
    var rowId = row.getAttribute("data-comment-row");
    var found = null;
    (card.comments || []).forEach(function (c) { if (c.id === rowId) found = c; });
    if (!found) return;
    card.comments = card.comments.filter(function (c) { return c.id !== found.id; });
    renderComments();
    render();
    queueCommentDelete(card, found);
  });
  wire("comment-add-btn", "click", function () {
    addCommentFromInput();
  });

  // The Next step chooser: a change is a hand-over, and it
  // acts at once. Editor fields still standing unsaved commit
  // first, the way a Move commits them; a conflict stops the
  // hand-over behind its answer, like any other act.
  wire("field-step", "change", function () {
    var select = document.getElementById("field-step");
    if (!select) return;
    var chosen = select.value;
    if (!commitEditorFields()) {
      editorPendingAfterConflict = function () { handOverFromEditor(chosen); };
      return;
    }
    handOverFromEditor(chosen);
  });

  // The form wraps the fields so Enter has somewhere harmless to
  // land. Nothing submits anywhere: the submit just closes the editor,
  // and closeEditor flushes the fields first.
  wire("editor-form", "submit", function (ev) {
    ev.preventDefault();
    closeEditor();
  });
  wire("editor-close", "click", function () {
    closeEditor();
  });
  wire("editor-backdrop", "click", function (ev) {
    if (ev.target === this) closeEditor();
  });
  // The conflict question's two answers.
  var conflictMine = document.getElementById("editor-conflict-mine");
  if (conflictMine) conflictMine.addEventListener("click", function () { resolveEditorConflict(false); });
  var conflictTheirs = document.getElementById("editor-conflict-theirs");
  if (conflictTheirs) conflictTheirs.addEventListener("click", function () { resolveEditorConflict(true); });

  wire("editor-archive", "click", function () {
    var card = findCard(editingId);
    if (card) {
      // A save stopped by a conflict stops the archive too: it
      // goes ahead on the answer, through this same handler.
      if (!commitEditorFields()) {
        editorPendingAfterConflict = function () {
          document.getElementById("editor-archive").click();
        };
        return;
      }
      if (isTempId(card.id)) {
        state.cards = state.cards.filter(function (c) { return c.id !== card.id; });
      } else {
        card.archived = true;
        saveQueued(function () {
          return api("PATCH", "/api/cards/" + encodeURIComponent(card.id), { archived: true });
        })
          .catch(function () { /* reloadState already ran */ });
      }
    }
    closeEditor();
  });
  // Deleting a card asks first, in the delete dialog (issue
  // #97): the dialog opens over the editor as it stands, and the
  // delete itself waits for the dialog's own button.
  wire("editor-delete", "click", function () {
    if (!editingId) return;
    var card = findCard(editingId);
    // A contested field stops the delete the same way it stops a
    // save: the question is answered first, then the delete goes
    // ahead through this same handler.
    if (card && editorSession && editorSession.cardId === card.id && !isTempId(card.id)) {
      var conflicts = editorConflicts(editorPersonValues(card));
      if (conflicts.length) {
        showEditorConflict(conflicts);
        editorPendingAfterConflict = function () {
          document.getElementById("editor-delete").click();
        };
        return;
      }
    }
    if (!card) return;
    openCardDeleteDialog(card, true);
  });
  wire("card-delete-confirm", "click", confirmCardDelete);
  wire("card-delete-cancel", "click", dismissCardDeleteDialog);
  var cardDeleteBackdrop = document.getElementById("card-delete-backdrop");
  if (cardDeleteBackdrop) {
    cardDeleteBackdrop.addEventListener("click", function (ev) {
      if (ev.target === cardDeleteBackdrop) dismissCardDeleteDialog();
    });
    cardDeleteBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") dismissCardDeleteDialog();
    });
  }

  // The key dialogs (issue #98) stand down the same ways: their
  // own close buttons, a press on the backdrop itself, Escape.
  wire("key-created-close", "click", closeKeyCreatedDialog);
  var keyCreatedBackdrop = document.getElementById("key-created-backdrop");
  if (keyCreatedBackdrop) {
    keyCreatedBackdrop.addEventListener("click", function (ev) {
      if (ev.target === keyCreatedBackdrop) closeKeyCreatedDialog();
    });
    keyCreatedBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeKeyCreatedDialog();
    });
  }
  wire("people-invite-btn", "click", function () {
    var input = document.getElementById("people-invite-name");
    var name = input ? input.value.trim() : "";
    if (!name) {
      peopleNote("Type the name the invite should carry.");
      return;
    }
    mintPersonInvite(name);
  });
  wire("invite-created-close", "click", closeInviteCreatedDialog);
  var inviteCreatedBackdrop = document.getElementById("invite-created-backdrop");
  if (inviteCreatedBackdrop) {
    inviteCreatedBackdrop.addEventListener("click", function (ev) {
      if (ev.target === inviteCreatedBackdrop) closeInviteCreatedDialog();
    });
    inviteCreatedBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeInviteCreatedDialog();
    });
  }
  wire("copy-invite", "click", function () {
    var field = document.getElementById("invite-link");
    copyFieldText(field ? field.value : "", document.getElementById("copy-invite"));
  });
  wire("person-delete-confirm", "click", confirmPersonDelete);
  wire("person-delete-cancel", "click", closePersonDeleteDialog);
  wire("passkey-remove-confirm", "click", confirmPasskeyRemove);
  wire("passkey-remove-cancel", "click", closePasskeyRemoveDialog);
  wire("own-passkey-remove-confirm", "click", confirmOwnPasskeyRemove);
  wire("own-passkey-remove-cancel", "click", closeOwnPasskeyRemoveDialog);
  var passkeyRemoveBackdrop = document.getElementById("passkey-remove-backdrop");
  if (passkeyRemoveBackdrop) {
    passkeyRemoveBackdrop.addEventListener("click", function (ev) {
      if (ev.target === passkeyRemoveBackdrop) closePasskeyRemoveDialog();
    });
    passkeyRemoveBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closePasskeyRemoveDialog();
    });
  }
  var ownPasskeyRemoveBackdrop = document.getElementById("own-passkey-remove-backdrop");
  if (ownPasskeyRemoveBackdrop) {
    ownPasskeyRemoveBackdrop.addEventListener("click", function (ev) {
      if (ev.target === ownPasskeyRemoveBackdrop) closeOwnPasskeyRemoveDialog();
    });
    ownPasskeyRemoveBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeOwnPasskeyRemoveDialog();
    });
  }
  // The Account page's sign-in section (issue #109).
  wire("account-passkey-add", "click", addPasskey);
  wire("account-proof-password-btn", "click", proofByPassword);
  wire("account-proof-passkey-btn", "click", proofByPasskey);
  wire("account-password-btn", "click", changeOwnPassword);
  wire("account-password-remove", "click", openPasswordDropDialog);
  wire("password-drop-confirm", "click", confirmPasswordDrop);
  wire("password-drop-cancel", "click", closePasswordDropDialog);
  var passwordDropBackdrop = document.getElementById("password-drop-backdrop");
  if (passwordDropBackdrop) {
    passwordDropBackdrop.addEventListener("click", function (ev) {
      if (ev.target === passwordDropBackdrop) closePasswordDropDialog();
    });
    passwordDropBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closePasswordDropDialog();
    });
  }
  wire("account-signout-everywhere", "click", signOutEverywhere);
  var personDeleteBackdrop = document.getElementById("person-delete-backdrop");
  if (personDeleteBackdrop) {
    personDeleteBackdrop.addEventListener("click", function (ev) {
      if (ev.target === personDeleteBackdrop) closePersonDeleteDialog();
    });
    personDeleteBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closePersonDeleteDialog();
    });
  }
  wire("key-delete-confirm", "click", confirmKeyDelete);
  wire("key-delete-cancel", "click", closeKeyDeleteDialog);
  var keyDeleteBackdrop = document.getElementById("key-delete-backdrop");
  if (keyDeleteBackdrop) {
    keyDeleteBackdrop.addEventListener("click", function (ev) {
      if (ev.target === keyDeleteBackdrop) closeKeyDeleteDialog();
    });
    keyDeleteBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeKeyDeleteDialog();
    });
  }

  // The delete dialogs of the dialog sweep (issue #99) stand
  // down the same ways: their own cancel buttons, a press on
  // the backdrop itself, Escape. The project dialog's Escape
  // stops here, so the press editor underneath it — which
  // Escape would otherwise settle — stands untouched. The
  // account dialog's confirm and cancel are wired with the
  // account section below; what stands here is its backdrop
  // and Escape.
  wire("project-delete-confirm", "click", confirmProjectDelete);
  wire("project-delete-cancel", "click", closeProjectDeleteDialog);
  var projectDeleteBackdrop = document.getElementById("project-delete-backdrop");
  if (projectDeleteBackdrop) {
    projectDeleteBackdrop.addEventListener("click", function (ev) {
      if (ev.target === projectDeleteBackdrop) closeProjectDeleteDialog();
    });
    projectDeleteBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        closeProjectDeleteDialog();
      }
    });
  }
  wire("board-delete-confirm", "click", confirmBoardDelete);
  wire("board-delete-cancel", "click", closeBoardDeleteDialog);
  var boardDeleteBackdrop = document.getElementById("board-delete-backdrop");
  if (boardDeleteBackdrop) {
    boardDeleteBackdrop.addEventListener("click", function (ev) {
      if (ev.target === boardDeleteBackdrop) closeBoardDeleteDialog();
    });
    boardDeleteBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeBoardDeleteDialog();
    });
  }
  wire("label-delete-confirm", "click", confirmLabelDelete);
  wire("label-delete-cancel", "click", closeLabelDeleteDialog);
  var labelDeleteBackdrop = document.getElementById("label-delete-backdrop");
  if (labelDeleteBackdrop) {
    labelDeleteBackdrop.addEventListener("click", function (ev) {
      if (ev.target === labelDeleteBackdrop) closeLabelDeleteDialog();
    });
    labelDeleteBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeLabelDeleteDialog();
    });
  }
  var accountDeleteBackdrop = document.getElementById("account-delete-backdrop");
  if (accountDeleteBackdrop) {
    accountDeleteBackdrop.addEventListener("click", function (ev) {
      if (ev.target === accountDeleteBackdrop) closeAccountDeleteDialog();
    });
    accountDeleteBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeAccountDeleteDialog();
    });
  }

  // The Schedule and See all columns controls: both are icon
  // buttons in the header — the Schedule on every screen, the
  // See all columns on a phone, pinned at the right of the board
  // row. The Schedule swaps the columns for the schedule and
  // back; the zoom swaps the one column for the overview and back.
  wire("schedule-toggle", "click", toggleSchedule);
  wire("overview-toggle", "click", toggleOverview);

  // Search: the header button slides the bar in and out; typing
  // re-runs the results alone, and every filter control repaints
  // the whole search from its standing state.
  wire("search-toggle", "click", toggleSearch);
  var searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      searchText = searchInput.value;
      renderSearchResults();
    });
    searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeSearch();
    });
  }
  wire("search-filters-btn", "click", function () {
    searchFiltersOpen = !searchFiltersOpen;
    renderSearch();
  });
  wire("archived-toggle", "click", function () {
    archivedOpen = !archivedOpen;
    render();
  });
  var searchBoardSel = document.getElementById("search-board");
  if (searchBoardSel) searchBoardSel.addEventListener("change", function () {
    searchBoardId = searchBoardSel.value;
    // The project and label picks follow the board scope; a scope
    // change starts them over rather than stranding a pick the
    // new scope does not hold.
    searchProjectId = "";
    searchLabelId = "";
    renderSearch();
  });
  var searchProjectSel = document.getElementById("search-project");
  if (searchProjectSel) searchProjectSel.addEventListener("change", function () {
    searchProjectId = searchProjectSel.value;
    renderSearch();
  });
  var searchLabelSel = document.getElementById("search-label");
  if (searchLabelSel) searchLabelSel.addEventListener("change", function () {
    searchLabelId = searchLabelSel.value;
    renderSearch();
  });
  wire("search-archived-bubble", "click", function () {
    searchArchived = !searchArchived;
    renderSearch();
  });
  wire("back-to-top", "click", function () {
    var smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  });
  window.addEventListener("scroll", paintBackToTop, { passive: true });

  // The Updated notice's button: the one reload a moved build
  // stamp ever causes, pressed by the person (issue #67).
  wire("update-refresh", "click", function () {
    window.location.reload();
  });
  // Theme controls. The header button steps Default, Light, Dark
  // and back to Default. The Settings buttons name the same modes.
  wire("theme-toggle", "click", function () {
    var next = THEME_MODES[(THEME_MODES.indexOf(currentThemeMode()) + 1) % THEME_MODES.length];
    setThemeMode(next);
  });
  document.querySelectorAll(".theme-mode-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setThemeMode(btn.getAttribute("data-theme-mode"));
    });
  });
  document.querySelectorAll(".look-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setLook(btn.getAttribute("data-look"));
    });
  });
  // A device that flips its own setting repaints the app at once, but
  // only for a person whose mode is System.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (currentThemeMode() === "system") applyTheme();
  });

  // Settings gear and panel
  wire("settings-open", "click", function () {
    if (state) openSettings();
  });
  // The Account button opens the Account page's own view.
  wire("account-open", "click", function () {
    if (state) openAccount();
  });
  wire("account-close", "click", function () {
    closeAccount();
  });
  wire("settings-close", "click", function () {
    closeSettings();
  });
  wire("settings-list", "click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("[data-settings-page]") : null;
    if (!btn) return;
    showSettingsPage(btn.getAttribute("data-settings-page"));
  });
  wire("settings-back", "click", function () {
    showSettingsPage(null);
  });
  wire("settings-backdrop", "click", function (ev) {
    if (ev.target === this) closeSettings();
  });

  // Settings Labels section. A rename paints as the person types and
  // saves when the field settles. A colour saves the moment it is
  // picked. Delete opens its dialog (issue #99); Add acts at once.
  var labelsWrap = byId("settings-labels");
  function labelFromRow(row) {
    if (!row || !state) return null;
    var id = row.getAttribute("data-label-row");
    for (var i = 0; i < state.labels.length; i++) {
      if (state.labels[i].id === id) return state.labels[i];
    }
    return null;
  }
  if (labelsWrap) labelsWrap.addEventListener("input", function (ev) {
    if (ev.target.getAttribute("data-role") !== "name") return;
    var label = labelFromRow(ev.target.closest("[data-label-row]"));
    if (!label) return;
    label.name = ev.target.value;
    render();
  });
  if (labelsWrap) labelsWrap.addEventListener("change", function (ev) {
    var label = labelFromRow(ev.target.closest("[data-label-row]"));
    if (!label) return;
    if (ev.target.getAttribute("data-role") === "name") {
      var cleanName = ev.target.value.trim();
      if (!cleanName) {
        ev.target.value = label.name;
        renderSettings();
        return;
      }
      label.name = cleanName;
      render();
      if (!isTempId(label.id)) {
        saveQueued(function () {
          return api("PATCH", "/api/labels/" + encodeURIComponent(label.id), { name: cleanName });
        }).catch(function () { /* reloadState already ran */ });
      }
    }
    if (ev.target.getAttribute("data-role") === "colour") {
      label.colour = ev.target.value;
      var preview = ev.target.closest("[data-label-row]").querySelector("[data-role='preview']");
      var palette = paletteColors(paletteFor(label.colour));
      if (preview) {
        preview.style.background = palette.bg;
        preview.style.borderColor = palette.border;
      }
      render();
      if (!isTempId(label.id)) {
        saveQueued(function () {
          return api("PATCH", "/api/labels/" + encodeURIComponent(label.id), { colour: label.colour });
        }).catch(function () { /* reloadState already ran */ });
      }
    }
  });
  if (labelsWrap) labelsWrap.addEventListener("click", function (ev) {
    var role = ev.target.getAttribute("data-role");
    if (role === "delete") {
      var row = ev.target.closest("[data-label-row]");
      if (!row) return;
      openLabelDeleteDialog(labelFromRow(row));
      return;
    }
    if (role === "add-label") {
      var addRow = ev.target.closest("[data-add-for]");
      if (!addRow) return;
      var boardId = addRow.getAttribute("data-add-for");
      var nameInput = addRow.querySelector("[data-role='add-name']");
      var colourInput = addRow.querySelector("[data-role='add-colour']");
      var name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      var label = {
        id: tempId("label"),
        boardId: boardId,
        name: name,
        icon: labelAddIconDrafts[boardId] || "",
        colour: colourInput.value
      };
      label.iconSent = label.icon;
      state.labels.push(label);
      // The add is spent: clear the box and the icon draft before
      // the rebuild, so the draft restore in renderSettings does
      // not bring either back.
      nameInput.value = "";
      delete labelAddIconDrafts[boardId];
      render();
      renderSettings();
      // The board itself can be brand new: read its id when the
      // queued step runs, through the board object, whose id the
      // board's own queued step swaps for the real one.
      var labelBoard = findBoard(boardId);
      saveQueued(function () {
        return api("POST", "/api/labels", { board_id: labelBoard ? labelBoard.id : boardId, name: name, icon: label.iconSent, colour: label.colour });
      }, function (res) {
        idAliases[label.id] = res.label.id;
        state.cards.forEach(function (card) {
          if (card.labels) {
            card.labels = card.labels.map(function (id) { return id === label.id ? res.label.id : id; });
          }
        });
        label.id = res.label.id;
        // An icon picked while the create was in flight is local
        // only. Send it now that the label has its real id.
        if (label.iconPicked !== undefined && label.iconPicked !== (label.iconSent || "")) {
          var pickedIcon = label.iconPicked;
          saveQueued(function () {
            return api("PATCH", "/api/labels/" + encodeURIComponent(label.id), { icon: pickedIcon });
          }).catch(function () { /* reloadState already ran */ });
        }
        delete label.iconPicked;
        delete label.iconSent;
        render();
        renderSettings();
      }).catch(function () { /* reloadState already ran */ });
    }
  });

  // Settings Projects section. The Labels pattern, in the
  // project's own shapes: a rename paints as the person types and
  // saves when the field settles, Delete opens the shared project
  // delete dialog (issue #99), and Add acts at once.
  var projectsWrapEl = byId("settings-projects");
  function projectFromRow(row) {
    if (!row || !state) return null;
    var id = row.getAttribute("data-project-row");
    for (var i = 0; i < state.projects.length; i++) {
      if (state.projects[i].id === id) return state.projects[i];
    }
    return null;
  }
  if (projectsWrapEl) projectsWrapEl.addEventListener("input", function (ev) {
    if (ev.target.getAttribute("data-role") !== "project-name") return;
    var proj = projectFromRow(ev.target.closest("[data-project-row]"));
    if (!proj) return;
    proj.name = ev.target.value;
    render();
  });
  if (projectsWrapEl) projectsWrapEl.addEventListener("change", function (ev) {
    var proj = projectFromRow(ev.target.closest("[data-project-row]"));
    if (!proj) return;
    var role = ev.target.getAttribute("data-role");
    if (role === "project-name") {
      var cleanName = ev.target.value.trim();
      if (!cleanName) {
        ev.target.value = proj.name;
        renderSettings();
        return;
      }
      proj.name = cleanName;
      render();
      if (!isTempId(proj.id)) {
        saveQueued(function () {
          return api("PATCH", "/api/projects/" + encodeURIComponent(proj.id), { name: cleanName });
        }).catch(function () { /* reloadState already ran */ });
      }
    }
  });
  if (projectsWrapEl) projectsWrapEl.addEventListener("click", function (ev) {
    var role = ev.target.getAttribute("data-role");
    if (role === "project-delete") {
      var row = ev.target.closest("[data-project-row]");
      if (!row) return;
      openProjectDeleteDialog(row.getAttribute("data-project-row"), false);
      return;
    }
    if (role === "add-project") {
      var addRow = ev.target.closest("[data-add-project-for]");
      if (!addRow) return;
      var boardId = addRow.getAttribute("data-add-project-for");
      var nameInput = addRow.querySelector("[data-role='add-name']");
      var name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      var project = {
        id: tempId("proj"),
        boardId: boardId,
        name: name,
        icon: projectAddIconDrafts[boardId] || ""
      };
      project.iconSent = project.icon;
      state.projects.push(project);
      nameInput.value = "";
      delete projectAddIconDrafts[boardId];
      render();
      renderSettings();
      var projectBoard = findBoard(boardId);
      saveQueued(function () {
        return api("POST", "/api/projects", { board_id: projectBoard ? projectBoard.id : boardId, name: name, icon: project.iconSent });
      }, function (res) {
        idAliases[project.id] = res.project.id;
        if (state.projectFilter === project.id) state.projectFilter = res.project.id;
        state.cards.forEach(function (card) {
          if (card.projectId === project.id) card.projectId = res.project.id;
        });
        project.id = res.project.id;
        if (project.iconPicked !== undefined && project.iconPicked !== (project.iconSent || "")) {
          var pickedIcon = project.iconPicked;
          saveQueued(function () {
            return api("PATCH", "/api/projects/" + encodeURIComponent(project.id), { icon: pickedIcon });
          }).catch(function () { /* reloadState already ran */ });
        }
        if (project.name !== res.project.name) {
          var driftName = project.name;
          saveQueued(function () {
            return api("PATCH", "/api/projects/" + encodeURIComponent(project.id), { name: driftName });
          }).catch(function () { /* reloadState already ran */ });
        }
        delete project.iconPicked;
        delete project.iconSent;
        render();
        renderSettings();
      }).catch(function () { /* reloadState already ran */ });
    }
  });

  // Settings Boards section. Renaming follows the labels pattern: the
  // name paints as the person types and the switcher follows at once;
  // the rename saves when the field settles.
  var boardsWrap = byId("settings-boards-list");
  function boardFromRow(row) {
    if (!row || !state) return null;
    var id = row.getAttribute("data-board-row");
    return findBoard(id);
  }
  if (boardsWrap) boardsWrap.addEventListener("input", function (ev) {
    if (ev.target.getAttribute("data-role") !== "board-name") return;
    var board = boardFromRow(ev.target.closest("[data-board-row]"));
    if (!board) return;
    board.name = ev.target.value;
    render();
  });
  if (boardsWrap) boardsWrap.addEventListener("change", function (ev) {
    if (ev.target.getAttribute("data-role") !== "board-name") return;
    var board = boardFromRow(ev.target.closest("[data-board-row]"));
    if (!board) return;
    var cleanName = ev.target.value.trim();
    if (!cleanName) {
      ev.target.value = board.name;
      renderSettings();
      return;
    }
    board.name = cleanName;
    render();
    renderSettings();
    if (!isTempId(board.id)) {
      saveQueued(function () {
        return api("PATCH", "/api/boards/" + encodeURIComponent(board.id), { name: cleanName });
      }).catch(function () { /* reloadState already ran */ });
    }
  });
  if (boardsWrap) boardsWrap.addEventListener("change", function (ev) {
    if (ev.target.getAttribute("data-role") !== "board-label-mode") return;
    var board = boardFromRow(ev.target.closest("[data-board-row]"));
    if (!board) return;
    // The mode paints the board behind the settings at once and
    // saves like every other edit on this page.
    board.labelColourMode = ev.target.value;
    render();
    if (!isTempId(board.id)) {
      var mode = ev.target.value;
      saveQueued(function () {
        return api("PATCH", "/api/boards/" + encodeURIComponent(board.id), { label_colour_mode: mode });
      }).catch(function () { /* reloadState already ran */ });
    }
  });
  if (boardsWrap) boardsWrap.addEventListener("click", function (ev) {
    if (ev.target.getAttribute("data-role") !== "board-delete") return;
    var board = boardFromRow(ev.target.closest("[data-board-row]"));
    if (!board) return;
    openBoardDeleteDialog(board);
  });
  if (boardsWrap) boardsWrap.addEventListener("click", function (ev) {
    if (ev.target.getAttribute("data-role") !== "board-copy") return;
    var board = boardFromRow(ev.target.closest("[data-board-row]"));
    if (board) openCopyDialog(board);
  });
  // The copy dialog's checkboxes: ticking Cards ticks Labels and
  // Projects with it, and the warning line follows the ticks.
  ["copy-columns", "copy-labels", "copy-projects", "copy-cards"].forEach(function (id) {
    var box = document.getElementById(id);
    if (!box) return;
    box.addEventListener("change", function () {
      if (id === "copy-cards" && box.checked) {
        document.getElementById("copy-labels").checked = true;
        document.getElementById("copy-projects").checked = true;
      }
      paintCopyWarning();
    });
  });
  wire("copy-submit", "click", submitCopyDialog);
  wire("copy-cancel", "click", closeCopyDialog);
  wire("column-remove-submit", "click", submitColumnRemoveDialog);
  wire("column-remove-cancel", "click", closeColumnRemoveDialog);
  var columnRemoveBackdrop = document.getElementById("column-remove-backdrop");
  if (columnRemoveBackdrop) {
    columnRemoveBackdrop.addEventListener("click", function (ev) {
      if (ev.target === columnRemoveBackdrop) closeColumnRemoveDialog();
    });
  }
  var copyBackdrop = document.getElementById("copy-backdrop");
  if (copyBackdrop) {
    copyBackdrop.addEventListener("click", function (ev) {
      if (ev.target === copyBackdrop) closeCopyDialog();
    });
    copyBackdrop.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeCopyDialog();
    });
  }
  // The board add row's icon picker. Its pick waits in a draft and
  // rides the create call; the new board starts from the plain
  // default when nothing was picked.
  var boardAddPicker = mountIconPicker(document.getElementById("board-add-icon-mount"),
    function () { return boardAddIconDraft || "🗂️"; }, {
      clearLabel: "Use the default",
      ariaLabel: "Icon for the new board",
      onPick: function (picked) {
        boardAddIconDraft = picked;
        boardAddPicker.refresh();
      }
    });
  wire("board-add-btn", "click", function () {
    if (!state) return;
    var input = document.getElementById("board-add-name");
    var name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    var board = {
      id: tempId("board"),
      name: name,
      icon: boardAddIconDraft || boardIconDefault({ name: name }),
      position: state.boards.length,
      columns: DEFAULT_COLUMN_KINDS.map(function (c, i) {
        return { id: "", kind: c.kind, name: c.name, position: i };
      })
    };
    board.iconSent = boardAddIconDraft;
    state.boards.push(board);
    input.value = "";
    boardAddIconDraft = "";
    boardAddPicker.refresh();
    render();
    renderSettings();
    saveQueued(function () {
      return api("POST", "/api/boards", { name: board.name, icon: board.iconSent });
    }, function (res) {
      var localName = board.name;
      var oldId = board.id;
      idAliases[oldId] = res.board.id;
      board.id = res.board.id;
      board.columns = res.board.columns;
      board.position = res.board.position;
      if (state.activeBoard === oldId) state.activeBoard = res.board.id;
      // A card, label or project made on the new board in the
      // moments before this returned still carries the temporary
      // board id. Point them all at the real one.
      state.cards.forEach(function (card) {
        if (card.boardId === oldId) card.boardId = res.board.id;
      });
      state.labels.forEach(function (label) {
        if (label.boardId === oldId) label.boardId = res.board.id;
      });
      state.projects.forEach(function (project) {
        if (project.boardId === oldId) project.boardId = res.board.id;
      });
      if (localName !== res.board.name) {
        board.name = localName;
        saveQueued(function () {
          return api("PATCH", "/api/boards/" + encodeURIComponent(board.id), { name: localName });
        }).catch(function () { /* reloadState already ran */ });
      }
      // An icon picked while the create was in flight is local
      // only. Send it now, or settle the painted icon on the
      // default for the board's final name.
      if (board.iconPicked !== undefined && board.iconPicked !== (board.iconSent || "")) {
        var pickedBoardIcon = board.iconPicked;
        saveQueued(function () {
          return api("PATCH", "/api/boards/" + encodeURIComponent(board.id), { icon: pickedBoardIcon });
        }).catch(function () { /* reloadState already ran */ });
      } else if (!board.iconSent) {
        board.icon = boardIconDefault(board);
      }
      delete board.iconPicked;
      delete board.iconSent;
      render();
      renderSettings();
    }).catch(function () { /* reloadState already ran */ });
  });

  // Settings Columns section. The picker chooses which board's
  // columns are listed. A rename paints as the person types and
  // saves when the field settles, like boards and labels. Up, Down,
  // Remove and + Column act at once.
  wire("columns-board-picker", "change", function () {
    columnsSettingsBoardId = this.value;
    renderSettings();
  });
  // The Labels and Projects pickers work the same way (issue #96).
  wire("labels-board-picker", "change", function () {
    labelsSettingsBoardId = this.value;
    renderSettings();
  });
  wire("projects-board-picker", "change", function () {
    projectsSettingsBoardId = this.value;
    renderSettings();
  });
  var columnsWrap = byId("settings-columns-list");
  function columnFromRow(row) {
    if (!row || !state) return { board: null, column: null };
    var board = findBoard(columnsSettingsBoardId);
    return { board: board, column: board ? findColumn(board, row.getAttribute("data-column-row")) : null };
  }
  // Renumbers a board's columns in the local state to match their
  // order in the given list, so what the board paints and what the
  // Settings list shows agree before the server answers.
  function applyColumnOrder(board, ordered) {
    ordered.forEach(function (col, i) { col.position = i; });
    board.columns = ordered.slice();
  }
  if (columnsWrap) columnsWrap.addEventListener("input", function (ev) {
    if (ev.target.getAttribute("data-role") !== "column-name") return;
    var found = columnFromRow(ev.target.closest("[data-column-row]"));
    if (!found.column) return;
    found.column.name = ev.target.value;
    render();
  });
  if (columnsWrap) columnsWrap.addEventListener("change", function (ev) {
    if (ev.target.getAttribute("data-role") !== "column-name") return;
    var found = columnFromRow(ev.target.closest("[data-column-row]"));
    if (!found.column) return;
    var column = found.column;
    var cleanName = ev.target.value.trim();
    if (!cleanName) {
      ev.target.value = column.name;
      renderSettings();
      return;
    }
    column.name = cleanName;
    render();
    renderSettings();
    if (!isTempId(column.id)) {
      saveQueued(function () {
        return api("PATCH", "/api/columns/" + encodeURIComponent(column.id), { name: cleanName });
      }).catch(function () { /* reloadState already ran */ });
    }
  });
  if (columnsWrap) columnsWrap.addEventListener("click", function (ev) {
    var role = ev.target.getAttribute("data-role");
    if (role !== "column-up" && role !== "column-down" && role !== "column-remove") return;
    var found = columnFromRow(ev.target.closest("[data-column-row]"));
    if (!found.board || !found.column) return;
    var board = found.board;
    var column = found.column;
    var ordered = columnsOf(board);
    var index = ordered.indexOf(column);
    if (index === -1) return;

    if (role === "column-remove") {
      if (ordered.length <= 1) return;
      // Every removal asks first (issue #135): the dialog
      // serves the empty column as it serves the full one.
      openColumnRemoveDialog(board, column);
      return;
    }

    var swapIndex = role === "column-up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= ordered.length) return;
    var neighbour = ordered[swapIndex];
    ordered[swapIndex] = column;
    ordered[index] = neighbour;
    applyColumnOrder(board, ordered);
    render();
    renderSettings();
    if (!isTempId(column.id)) {
      var newIndex = ordered.indexOf(column);
      saveQueued(function () {
        return api("PATCH", "/api/columns/" + encodeURIComponent(column.id), { position: newIndex });
      }).catch(function () { /* reloadState already ran */ });
    }
  });
  wire("column-add-btn", "click", function () {
    if (!state) return;
    var board = findBoard(columnsSettingsBoardId);
    if (!board) return;
    var column = {
      id: tempId("col"),
      kind: genColumnKind(board),
      name: "New column",
      position: board.columns ? board.columns.length : 0
    };
    if (!board.columns) board.columns = [];
    board.columns.push(column);
    render();
    renderSettings();
    // The board itself can be brand new: read its id when the queued
    // step runs, through the board object, whose id the board's own
    // queued step swaps for the real one.
    saveQueued(function () {
      return api("POST", "/api/columns", { board_id: board.id, name: column.name, kind: column.kind });
    }, function (res) {
      idAliases[column.id] = res.column.id;
      column.id = res.column.id;
      if (res.column.kind && res.column.kind !== column.kind) {
        if (state.activeBoard === board.id && state.activeColumn === column.kind) {
          state.activeColumn = res.column.kind;
        }
        column.kind = res.column.kind;
      }
      // A rename or a reorder that landed while the create was in
      // flight is local only. Send the differences now, so the
      // server ends up holding exactly what the screen shows.
      if (column.name !== res.column.name) {
        var driftName = column.name;
        saveQueued(function () {
          return api("PATCH", "/api/columns/" + encodeURIComponent(column.id), { name: driftName });
        }).catch(function () { /* reloadState already ran */ });
      }
      if (column.iconPicked !== undefined && column.iconPicked !== "") {
        var driftColumnIcon = column.iconPicked;
        saveQueued(function () {
          return api("PATCH", "/api/columns/" + encodeURIComponent(column.id), { icon: driftColumnIcon });
        }).catch(function () { /* reloadState already ran */ });
      }
      delete column.iconPicked;
      var localIndex = columnsOf(board).indexOf(column);
      if (localIndex !== -1 && localIndex !== res.column.position) {
        saveQueued(function () {
          return api("PATCH", "/api/columns/" + encodeURIComponent(column.id), { position: localIndex });
        }).catch(function () { /* reloadState already ran */ });
      }
      render();
      renderSettings();
    }).catch(function () { /* reloadState already ran */ });
  });

  // Set Up Agent buttons.
  wire("copy-instructions", "click", function () {
    copyFieldText(document.getElementById("agent-instructions").value, this);
  });
  // "What your agent will read": opens a read-only view of the
  // directions the API serves, fetched fresh each time it opens,
  // so the person sees the very text their agent will be told.
  // It changes nothing and holds no key: the fetch rides the
  // person's own sign-in, the way every panel read does.
  wire("directions-toggle", "click", function () {
    var view = document.getElementById("directions-view");
    var note = document.getElementById("directions-note");
    if (!view) return;
    if (!view.hidden) {
      view.hidden = true;
      this.textContent = "What your agent will read";
      if (note) note.textContent = "";
      return;
    }
    this.textContent = "Hide the directions";
    if (note) note.textContent = "Reading the directions…";
    fetchDirectionsText().then(function (text) {
      var field = document.getElementById("agent-directions");
      if (field) field.value = text;
      view.hidden = false;
      if (note) note.textContent = "";
    }).catch(function () {
      if (note) note.textContent = "The directions could not be read. Check your connection and try again.";
    });
  });
  wire("copy-key", "click", function () {
    copyFieldText(document.getElementById("agent-key").value, this);
  });
  // The person's display name (issue #66): editing the field
  // saves at once, the way every edit in the app does, and the
  // account line follows. A refused save puts the standing name
  // back and says so in the note.
  wire("account-name-input", "change", function () {
    var input = this;
    var note = document.getElementById("account-note");
    var name = input.value.trim();
    if (!name || (state && name === state.me.name)) {
      if (state) input.value = state.me.name || "";
      return;
    }
    queueWrite(function () {
      return api("PATCH", "/api/me", { name: name });
    }).then(function (res) {
      if (state && res && res.name) state.me.name = res.name;
      if (note) note.textContent = "";
      renderSettings();
    }).catch(function () {
      if (note) note.textContent = "That name could not be saved. Check your connection and try again.";
      if (state) input.value = state.me.name || "";
    });
  });
  // Logging out clears the local mirror (issue #58): on a shared
  // browser nothing of the last person's stays behind in local
  // storage. The link's own navigation carries on untouched.
  wire("logout-link", "click", function () {
    try { localStorage.removeItem(MIRROR_KEY); } catch (e) { /* storage may be unavailable */ }
  });
  // Deleting the account (issue #57): the first press opens the
  // delete dialog (issue #99) and names the standing counts in
  // it, so the person sees the size of the act before they
  // commit to it. The confirm button waits for DELETE typed in
  // full inside the dialog. The act itself is
  // one call with no body; the server ends the session in its
  // answer, and the browser then follows the logout link's
  // address — the address a person whose session is over is
  // sent to on either door. The local mirror goes too, the
  // same as on logout.
  wire("account-delete-btn", "click", function () {
    var backdrop = document.getElementById("account-delete-backdrop");
    var note = document.getElementById("account-delete-note");
    var type = document.getElementById("account-delete-type");
    var confirmBtn = document.getElementById("account-delete-confirm-btn");
    var boards = state ? state.boards.length : 0;
    var cards = state ? state.cards.length : 0;
    if (note) {
      note.textContent = "This deletes your " + boards + (boards === 1 ? " board" : " boards") +
        " and " + cards + (cards === 1 ? " card" : " cards") +
        ", with every step, link and comment on them, and all your agent keys. It cannot be undone." +
        " Copies inside the nightly backups age out within 14 days.";
    }
    if (type) type.value = "";
    if (confirmBtn) confirmBtn.disabled = true;
    if (backdrop) backdrop.hidden = false;
    if (type) type.focus();
  });
  wire("account-delete-type", "input", function () {
    var confirmBtn = document.getElementById("account-delete-confirm-btn");
    if (confirmBtn) confirmBtn.disabled = this.value !== "DELETE";
  });
  wire("account-delete-cancel", "click", closeAccountDeleteDialog);
  wire("account-delete-confirm-btn", "click", function () {
    var logout = document.getElementById("logout-link");
    var target = logout ? logout.getAttribute("href") : "/";
    api("DELETE", "/api/me").then(function () {
      try { localStorage.removeItem(MIRROR_KEY); } catch (e) { /* storage may be unavailable */ }
      window.location.href = target;
    }).catch(function (err) {
      // The server's refusal words stand when it gives a
      // reason (issue #149) — the sole-administrator guard
      // refuses in plain words, and "check your connection"
      // would send the person retrying an act that can never
      // succeed. The connection line remains for failures
      // that carry no reason.
      var note = document.getElementById("account-delete-note");
      if (note) note.textContent = (err && err.message) ||
        "The deletion did not go through. Check your connection and try again.";
    });
  });
  // Add a key: the name from the field (or "Agent" when it stands
  // empty), and the full key shows once, in its own dialog (issue
  // #98). Nothing existing is touched: the new key works alongside
  // the old ones.
  wire("key-add", "click", function () {
    var note = document.getElementById("key-note");
    var nameField = document.getElementById("key-add-name");
    var name = nameField ? nameField.value.trim() : "";
    queueWrite(function () {
      return api("POST", "/api/me/token", { name: name || "Agent" });
    }).then(function (res) {
      if (state) state.key = { has_key: true, last4: res.last4, created_at: res.created_at };
      if (nameField) nameField.value = "";
      if (note) note.textContent = "";
      agentKeys = null;
      refreshAgentKeys();
      renderSettings();
      openKeyCreatedDialog(res.key);
    }).catch(function () {
      if (note) note.textContent = "Adding a key did not work. Check your connection and try again.";
    });
  });
  // The key list's own buttons: rename opens the row's field and
  // delete opens the delete dialog (issue #98). Every act re-reads
  // the list, so the page always shows the server's truth.
  var keysWrap = document.getElementById("keys-list");
  if (keysWrap) keysWrap.addEventListener("click", function (ev) {
    var role = ev.target.getAttribute("data-role");
    if (!role || role.indexOf("key-") !== 0) return;
    var note = document.getElementById("key-note");
    var row = ev.target.closest("[data-key-row]");
    var keyId = ev.target.getAttribute("data-key-id") || (row ? row.getAttribute("data-key-row") : null);
    if (role === "key-rename") {
      keyRenameId = keyId;
      renderSettings();
      var input = keysWrap.querySelector("[data-key-row='" + keyId + "'] [data-role='key-rename-input']");
      if (input) { input.focus(); input.select(); }
      return;
    }
    if (role === "key-rename-cancel") {
      keyRenameId = null;
      renderSettings();
      return;
    }
    if (role === "key-rename-save") {
      var field = row ? row.querySelector("[data-role='key-rename-input']") : null;
      var newName = field ? field.value.trim() : "";
      if (!newName) { if (field) field.focus(); return; }
      queueWrite(function () {
        return api("PATCH", "/api/me/token/" + encodeURIComponent(keyId), { name: newName });
      }).then(function () {
        keyRenameId = null;
        if (note) note.textContent = "";
        agentKeys = null;
        refreshAgentKeys();
        renderSettings();
      }).catch(function () {
        if (note) note.textContent = "Renaming the key did not work. Check your connection and try again.";
      });
      return;
    }
    if (role === "key-delete") {
      var key = (agentKeys || []).find(function (k) { return k.id === keyId; });
      if (key) openKeyDeleteDialog(key);
      return;
    }
  });

  // The load failure's two ways forward. Retry loads the boards
  // again in place. Reload starts the whole page over, which is
  // the way back through sign-in when the sign-in has lapsed.
  wire("retry-btn", "click", function () {
    bootLoad();
  });
  wire("reload-btn", "click", function () {
    window.location.reload();
  });

  // The icon picker's panel closes on an outside click or Escape.
  document.addEventListener("click", function (ev) {
    if (!openIconPanel) return;
    if (ev.target.closest && ev.target.closest(".icon-picker")) return;
    closeIconPanel();
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") closeIconPanel();
  });

  // Press-and-hold rename: the press is watched on the board
  // switcher and the project filter row, whose buttons are
  // rebuilt on every render, so the watching is delegated and
  // the movement and release are followed at the window. A
  // double-click opens the same editor, from the click handlers
  // themselves (see the switcher's click listener above).
  // Every press is remembered by kind, so the click it leaves
  // behind can tell a tap from a mouse click when the
  // double-click window is judged. A fresh press also clears a
  // press swallow record left standing by an earlier hold whose
  // release never did produce a click on its own button.
  document.addEventListener("pointerdown", function (ev) {
    lastPointerType = ev.pointerType || "";
    lastPointerAt = Date.now();
    pressSwallow = null;
  });
  var switcherEl = byId("board-switcher");
  if (switcherEl) switcherEl.addEventListener("pointerdown", function (ev) {
    var tab = ev.target.closest ? ev.target.closest(".board-tab") : null;
    if (tab) watchPressStart(ev, "board", tab.getAttribute("data-board"), tab);
  });
  var filterEl = byId("project-filter");
  if (filterEl) filterEl.addEventListener("pointerdown", function (ev) {
    var btn = ev.target.closest ? ev.target.closest(".filter-btn[data-project]") : null;
    if (btn) watchPressStart(ev, "project", btn.getAttribute("data-project"), btn);
  });
  window.addEventListener("pointermove", onPressMove);
  window.addEventListener("pointerup", onPressEnd);
  window.addEventListener("pointercancel", onPressEnd);
  // A long press on one of these buttons is the rename gesture;
  // the browser's own long-press menu stays out of its way.
  [switcherEl, filterEl].filter(Boolean).forEach(function (container) {
    container.addEventListener("contextmenu", function (ev) {
      var hit = ev.target.closest ? ev.target.closest(".board-tab, .filter-btn[data-project]") : null;
      if (hit) ev.preventDefault();
    });
  });
  // A press anywhere outside the open editor settles it, and so
  // does Escape. The press itself still does its own work: the
  // dismissal never eats the tap that caused it. The project
  // delete dialog standing over the editor is the exception:
  // a press on it is the dialog's own business, and the editor
  // underneath stands untouched until the dialog stands down.
  document.addEventListener("pointerdown", function (ev) {
    if (!pressEditor) return;
    if (projectDeleteTarget) return;
    if (ev.target.closest && ev.target.closest(".press-editor")) return;
    closePressEditor(true);
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && pressEditor && !projectDeleteTarget) closePressEditor(true);
  });

  // The display button in the header. The choice belongs to this
  // device: a click writes this browser's own storage and repaints
  // at once. Nothing is sent anywhere.
  wire("display-toggle", "click", function () {
    cycleDisplayMode();
  });

  // A tab coming back into view checks the change marker, so a
  // board left open catches up even if its socket went quiet.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) checkRemoteVersion();
  });

  // A window coming back into focus checks too (issue #10): the
  // standing check pauses while a tab is hidden, and a return —
  // the tab coming back into view, or the window into focus —
  // is what asks again.
  window.addEventListener("focus", function () {
    checkRemoteVersion();
  });

  // If the window crosses between phone width and wider while
  // the overview stands, paint again: the overview only ever
  // stands at phone width, and the columns take its place.
  window.matchMedia("(max-width: 899px)").addEventListener("change", function () {
    if (overviewOpen) render();
  });

  // Card dragging and the phone's column swipe share one set of
  // window pointer handlers: a press is watched from wherever it
  // began (a card, its grip, or the column area itself).
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  wire("columns", "pointerdown", watchSwipeStart);

  applyDisplayMode();
  applyTheme();
  bootLoad();
  registerServiceWorker();
}

// The service worker is what lets a phone offer TaskSparkle as an
// app on the home screen. It is registered here, off the load's
// path, and it is not allowed to matter to the boot: a browser
// without the feature, or a registration that fails, changes
// nothing about how the boards load. The worker itself keeps no
// copies of anything (see sw.js), so it can never hold a stale
// app the way a cache once did.
function registerServiceWorker() {
  try {
    if (!("serviceWorker" in navigator)) return;
    var registration = navigator.serviceWorker.register("/sw.js");
    if (registration && registration.catch) {
      registration.catch(function () { /* Installability is a bonus, never a blocker. */ });
    }
  } catch (e) { /* The boards load the same without it. */ }
}

// Whether the build the server runs has moved past the build
// this copy of the app is (issue #138). The boot asks it as the
// boards load, and the standing version check asks it on every
// tick, socket open and tab return. A disagreement never reloads
// the page (Site and Email Standards, Parts 8 and 9): it raises
// the standing Updated notice and the person presses Refresh
// now. A guard in session storage remembers the stamp the
// notice already stands for, so repeated checks raise it once;
// when the stamps agree the guard clears.
function serverBuildMoved(data) {
  if (!data || !data.build) return false;
  var guardKey = "tasksparkle-build-reload";
  if (data.build === BUILD_ID) {
    try { window.sessionStorage.removeItem(guardKey); } catch (e) { /* storage can refuse */ }
    return false;
  }
  var seen = null;
  try { seen = window.sessionStorage.getItem(guardKey); } catch (e) { seen = null; }
  if (seen === data.build) return false;
  try { window.sessionStorage.setItem(guardKey, data.build); } catch (e) { /* storage can refuse */ }
  return true;
}

// The boot. The boards load at once — the build-stamp check
// never stands in front of the first paint (Site and Email
// Standards, Part 9). The check rides along beside the load:
// the app reads the server's stamp from the static build file
// (issue #10), never cached, and when the stamps disagree the
// standing Updated notice rises and the person presses Refresh
// now. When the check itself cannot be made, a later check
// catches up.
function bootLoad() {
  fetch("/build.json", { cache: "no-store" }).then(function (res) {
    if (!res.ok) throw new Error("build " + res.status);
    return res.json();
  }).then(function (data) {
    if (serverBuildMoved(data)) showUpdateNote();
  }).catch(function () { /* a later check catches up */ });
  proceedToBoards();
}

// The door check (issue #109): before the boards load, ask the
// sign-in routes who this is. An account that stands but is not
// linked to any boards yet — a new account, or the first
// account on a copy whose board sets stand unclaimed — gets
// the waiting page (or, for an administrator, the claim list)
// instead of boards it cannot reach. A caller the sign-in
// routes refuse — the transition door's caller, during the
// window when it still stands — goes straight to the boards,
// as before.
function proceedToBoards() {
  api("GET", "/api/auth/me").then(function (me) {
    if (me && me.linked === false) {
      showUnlinked(me);
      return;
    }
    loadInitial();
  }).catch(function () {
    loadInitial();
  });
}

// The waiting page for an unlinked account. For an
// administrator it carries the claim list — the unclaimed
// board sets and the accounts one can be linked to — because
// linking the first set is the act that opens the copy. The
// page shows a set's shape only: the address it stands under,
// its board names, its card count, when it last changed —
// never a card's contents.
function showUnlinked(me) {
  var loading = byId("loading-state");
  if (loading) loading.hidden = true;
  var boardUi = byId("board-ui");
  if (boardUi) boardUi.hidden = true;
  var box = byId("unlinked-state");
  if (!box) { loadInitial(); return; }
  var note = byId("unlinked-note");
  if (note) {
    note.textContent = me.admin
      ? "Your account is not linked to any boards yet. Link a board set below — to your own account, or to another account that stands."
      : "Your account is not linked to any boards yet. Ask the person who runs this copy to link your account to your boards.";
  }
  box.hidden = false;
  if (!me.admin) return;
  api("GET", "/api/auth/people").then(function (data) {
    renderUnlinkedClaims(me, data);
  }).catch(function () { /* the waiting words above stand */ });
}

// The terms gate (issue #43): the note a terms change leaves
// standing inside, before the boards. It states only the
// date the terms changed, links to the Terms page in a new
// tab, and waits on an unticked box: Continue posts the new
// agreement, and the boards load behind it. The box starts
// unticked every time the gate stands — the agreement is
// this press's, never a remembered one.
var termsGateWired = false;
function showTermsGate(update) {
  var loading = byId("loading-state");
  if (loading) loading.hidden = true;
  var boardUi = byId("board-ui");
  if (boardUi) boardUi.hidden = true;
  var unlinked = byId("unlinked-state");
  if (unlinked) unlinked.hidden = true;
  var box = byId("terms-state");
  if (!box) { loadInitial(); return; }
  var note = byId("terms-note");
  if (note) {
    note.textContent = "The terms changed on " + termsDateWords(update.changedOn) + ".";
  }
  var agree = byId("terms-agree");
  var cont = byId("terms-continue");
  if (agree) agree.checked = false;
  if (cont) cont.disabled = true;
  box.hidden = false;
  if (!termsGateWired) {
    termsGateWired = true;
    if (agree && cont) {
      agree.addEventListener("change", function () { cont.disabled = !agree.checked; });
    }
    if (cont) {
      cont.addEventListener("click", function () {
        if (!agree || !agree.checked) return;
        cont.disabled = true;
        api("POST", "/api/terms/agree", { agreed: true }).then(function () {
          box.hidden = true;
          loadInitial();
        }).catch(function () {
          showApiError();
          cont.disabled = false;
        });
      });
    }
  }
}

// The standing's date in the words the Terms page prints it:
// the version is the page's "Last updated" date in ISO form,
// and the note speaks it in full — "November 7, 2026".
var TERMS_MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
function termsDateWords(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return TERMS_MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[1];
}

function renderUnlinkedClaims(me, data) {
  var wrap = byId("unlinked-claims");
  if (!wrap) return;
  wrap.innerHTML = "";
  var sets = (data && data.unclaimed) || [];
  if (!sets.length) {
    var none = document.createElement("p");
    none.className = "settings-note";
    none.textContent = "No board sets stand unclaimed. Reload and your boards will load.";
    wrap.appendChild(none);
    return;
  }
  sets.forEach(function (set) {
    var row = document.createElement("div");
    row.className = "board-manage-row";
    var label = document.createElement("span");
    var changed = set.lastChangeAt ? new Date(set.lastChangeAt).toLocaleString() : "never";
    label.textContent = (set.boards.length ? set.boards.join(", ") : "No boards") +
      " — " + set.cardCount + (set.cardCount === 1 ? " card" : " cards") +
      ", last changed " + changed + ".";
    row.appendChild(label);
    var pick = document.createElement("select");
    (data.people || []).forEach(function (person) {
      var opt = document.createElement("option");
      opt.value = person.key;
      opt.textContent = person.name;
      pick.appendChild(opt);
    });
    row.appendChild(pick);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Link to this account";
    btn.addEventListener("click", function () {
      api("POST", "/api/auth/claim", { owner_id: set.ownerId, account_key: pick.value })
        .then(function () {
          if (pick.value === me.key) { window.location.reload(); return; }
          showUnlinked(me);
        })
        .catch(function (err) {
          var note = wrap.querySelector(".link-error");
          if (!note) {
            note = document.createElement("p");
            note.className = "settings-note link-error";
            wrap.appendChild(note);
          }
          note.textContent = err.message || "Linking did not work. Try again.";
        });
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}

// The load is given this long before it is spoken of as failed:
// a hung request must not leave the loading line standing
// forever either.
var LOAD_TIMEOUT_MS = 12000;

// First load. The board UI stays hidden behind a plain loading
// line until the state lands. A load that fails, or that runs
// past its limit, trades the loading line for plain words about
// what happened and a way forward (see showLoadError).
function loadInitial() {
  var loading = byId("loading-state");
  var errorBox = byId("load-error");
  var boardUi = byId("board-ui");
  if (loading) loading.hidden = false;
  if (errorBox) errorBox.hidden = true;
  if (boardUi) boardUi.hidden = true;
  var settled = false;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    showLoadError(null, true);
  }, LOAD_TIMEOUT_MS);
  api("GET", "/api/state").then(function (fresh) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    adoptState(fresh);
    if (loading) loading.hidden = true;
    // The terms gate stands before the boards: the boards
    // load only once the standing is answered (issue #43).
    if (fresh.termsUpdate) { showTermsGate(fresh.termsUpdate); return; }
    if (boardUi) boardUi.hidden = false;
    render();
    applyTheme();
    startPush();

    // Links like ?settings=agent and ?open=<card id> open those views.
    // The screenshot tool uses them to capture panels.
    var params = new URLSearchParams(window.location.search);
    if (params.get("settings") === "agent" || params.get("settings") === "Muse") openSettings("setup-agent");
    else if (params.get("settings")) openSettings();
    var openId = params.get("open");
    if (openId && findCard(openId)) {
      var card = findCard(openId);
      state.activeBoard = card.boardId;
      state.activeColumn = card.columnId;
      render();
      openEditor(openId);
    }
  }).catch(function (err) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    showLoadError(err, false);
  });
}

// A failed load, spoken plainly, with the way forward that fits
// it: Retry loads again in place, and a lapsed sign-in gets
// Reload instead, because only a fresh page goes back through
// sign-in. Every element is taken by name and may be missing on
// an older page; saying so must never throw either.
function showLoadError(err, timedOut) {
  var loading = byId("loading-state");
  if (loading) loading.hidden = true;
  var errorBox = byId("load-error");
  if (!errorBox) return;
  var signedOut = !!(err && err.status === 401);
  var message = byId("load-error-message");
  if (message) {
    message.textContent = signedOut
      ? "Your sign-in has lapsed. Reload to sign in again."
      : timedOut
        ? "Loading your boards is taking too long. Check your connection, then try again."
        : "TaskSparkle could not load your boards. Check your connection, then try again.";
  }
  var retryBtn = byId("retry-btn");
  if (retryBtn) retryBtn.hidden = signedOut;
  var reloadBtn = byId("reload-btn");
  if (reloadBtn) reloadBtn.hidden = !signedOut;
  errorBox.hidden = false;
}

document.addEventListener("DOMContentLoaded", init);
