// Prevention & wellness handouts: healthy living (drafts; an admin reviews and approves each before patients see it).
import type { WellnessEntry } from "./types";

export const WELLNESS_LIVING: WellnessEntry[] = [
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_healthy_eating",
    education: {
      en: {
        title: "Healthy eating",
        summary: "Healthy eating means choosing mostly whole, simple foods: vegetables, fruits, beans, whole grains, and lean protein. It gives you energy and helps protect you from diabetes, heart disease, and high blood pressure. You don't have to give up the foods you love, because small changes add up.",
        whoFor: [
          "Everyone, at any age",
          "People who have, or are at risk for, diabetes, high blood pressure, or high cholesterol",
          "Anyone who wants more energy or wants to reach a healthy weight",
        ],
        howOften: "Every day, at every meal",
        whatToDo: [
          "Use the plate method: fill half your plate with vegetables, one quarter with lean protein (like chicken, fish, eggs, or beans), and one quarter with whole grains or starchy foods.",
          "Make your favorite dishes a little healthier. Choose whole beans (frijoles de la olla) instead of refried beans made with lard, pick corn tortillas, and try grilled chicken or fish fajitas with lots of peppers and onions. Add nopales or pico de gallo on the side.",
          "Enjoy Middle Eastern favorites like lentil soup, chickpeas and hummus, tabbouleh and fattoush salads, grilled kebabs, and whole-wheat pita. Olive oil is a good choice, but use a small amount.",
          "Choose whole grains like brown rice, whole-wheat bread, oatmeal, and bulgur. Keep rice, bread, tortillas, and pita to about one quarter of your plate.",
          "Drink water instead of soda, sweet tea, juice, energy drinks, and sweetened aguas frescas. Try water with lime, cucumber, or mint, or unsweetened tea.",
          "Eat less fast food and fewer processed foods, like chips, sweets, fried foods, and salty canned or packaged foods. Season with lemon, garlic, herbs, and spices instead of extra salt.",
          "Have fruit for dessert or a snack, and keep cut-up vegetables ready in the fridge.",
        ],
        whatToExpect: [
          "Many people have more energy and stay full longer within a few weeks.",
          "Your blood pressure, blood sugar, and cholesterol can get better over a few months.",
          "Your taste changes. After a few weeks of less sugar and salt, very sweet or salty foods may taste too strong.",
          "Slips happen. One meal does not undo your progress. Just make your next meal a healthy one.",
        ],
        talkToUs: [
          "You have diabetes, kidney disease, heart disease, or another condition and need an eating plan made for you.",
          "You would like help from a dietitian (a nutrition expert).",
          "It is hard to get enough food, or hard to pay for healthy food.",
          "You are losing or gaining weight without trying.",
        ],
      },
      es: {
        title: "Comer saludable",
        summary: "Comer saludable quiere decir escoger sobre todo alimentos naturales y sencillos: verduras, frutas, frijoles, granos integrales y proteína baja en grasa. Le da energía y le ayuda a protegerse de la diabetes, las enfermedades del corazón y la presión alta. No tiene que dejar las comidas que le gustan: los cambios pequeños suman.",
        whoFor: [
          "Todas las personas, a cualquier edad",
          "Personas que tienen diabetes, presión alta o colesterol alto, o que corren riesgo de tenerlos",
          "Quien quiera tener más energía o llegar a un peso saludable",
        ],
        howOften: "Todos los días, en cada comida",
        whatToDo: [
          "Use el método del plato: llene la mitad del plato con verduras, una cuarta parte con proteína baja en grasa (como pollo, pescado, huevo o frijoles) y la otra cuarta parte con granos integrales o almidones.",
          "Haga sus platillos favoritos un poco más saludables. Escoja frijoles de la olla en vez de frijoles refritos con manteca, prefiera las tortillas de maíz y pruebe fajitas de pollo o pescado a la parrilla con mucho pimiento y cebolla. Acompañe con nopales o pico de gallo.",
          "Disfrute platillos del Medio Oriente como sopa de lentejas, garbanzos y hummus, ensaladas como tabule y fattoush, kebabs a la parrilla y pan pita integral. El aceite de oliva es buena opción, pero use poquito.",
          "Escoja granos integrales como arroz integral, pan integral, avena y bulgur. Que el arroz, el pan, las tortillas y el pita no pasen de una cuarta parte del plato.",
          "Tome agua en vez de refrescos, té endulzado, jugos, bebidas energéticas y aguas frescas con azúcar. Pruebe el agua con limón, pepino o hierbabuena, o el té sin azúcar.",
          "Coma menos comida rápida y menos alimentos procesados, como papitas, dulces, frituras y comidas enlatadas o empacadas con mucha sal. Sazone con limón, ajo, hierbas y especias en vez de más sal.",
          "Coma fruta de postre o de merienda, y tenga verduras picadas listas en el refrigerador.",
        ],
        whatToExpect: [
          "Muchas personas tienen más energía y se sienten llenas por más tiempo en pocas semanas.",
          "La presión, el azúcar y el colesterol pueden mejorar en unos meses.",
          "El gusto cambia. Después de unas semanas con menos azúcar y sal, las comidas muy dulces o saladas le pueden saber demasiado fuertes.",
          "Todos tenemos tropiezos. Una comida no borra su progreso. Simplemente haga que la siguiente sea saludable.",
        ],
        talkToUs: [
          "Tiene diabetes, enfermedad de los riñones, enfermedad del corazón u otra condición y necesita un plan de alimentación hecho para usted.",
          "Quiere ayuda de un nutricionista (un experto en alimentación).",
          "Le cuesta conseguir suficiente comida o pagar alimentos saludables.",
          "Está bajando o subiendo de peso sin querer.",
        ],
      },
    },
    basis: [
      "Dietary Guidelines for Americans",
      "USDA MyPlate",
      "American Diabetes Association: Diabetes Plate Method",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_physical_activity",
    education: {
      en: {
        title: "Staying active",
        summary: "Moving your body is one of the best things you can do for your health. Regular activity helps your heart, blood sugar, blood pressure, mood, sleep, and weight. Any amount is better than none, and it is never too late to start.",
        whoFor: [
          "Everyone, at any age",
          "People with long-term conditions like diabetes, high blood pressure, or arthritis. Activity helps these too.",
          "Older adults, who also benefit from balance exercises",
        ],
        howOften: "Aim for 150 minutes a week of moderate activity, plus strength exercises 2 days a week",
        whatToDo: [
          "Moderate activity means you breathe harder but can still talk. Brisk walking, dancing, swimming, biking, and yard work all count.",
          "Break it up: 30 minutes a day, 5 days a week, or even 10 minutes at a time. Taking the stairs and walking more during the day count too.",
          "Do strength exercises 2 days a week. Use light weights, stretchy exercise bands, canned food, or your own body (like wall push-ups or standing up from a chair).",
          "Start slow. If you have not been active, begin with 5 to 10 minutes and add a few minutes each week.",
          "Beat the Houston heat: walk early in the morning or in the evening, or go to an air-conditioned mall, gym, or community center.",
          "Drink water before, during, and after activity, and wear light, loose clothes. Stop and cool down if you feel dizzy, sick to your stomach, very tired, or get a headache.",
          "If you are an older adult, add balance exercises, like tai chi or standing on one foot while holding on to a counter.",
        ],
        whatToExpect: [
          "You may sleep better and feel less stressed within the first couple of weeks.",
          "Some sore muscles are normal when you start. They should feel better in a day or two.",
          "Over a few months, your blood pressure, blood sugar, and strength often improve, and everyday tasks get easier.",
        ],
        talkToUs: [
          "You have chest pain, pressure, or tightness, bad shortness of breath, or you feel faint while active. Stop right away, and call 911 if it does not go away quickly.",
          "You have heart disease, diabetes, or another condition and want to start something harder than walking.",
          "You have joint pain or an injury that keeps you from moving.",
          "You want ideas for a plan that fits your body, your schedule, and your budget.",
        ],
      },
      es: {
        title: "Manténgase activo",
        summary: "Mover el cuerpo es una de las mejores cosas que puede hacer por su salud. La actividad regular ayuda al corazón, al azúcar en la sangre, a la presión, al ánimo, al sueño y al peso. Cualquier cantidad es mejor que nada, y nunca es tarde para empezar.",
        whoFor: [
          "Todas las personas, a cualquier edad",
          "Personas con condiciones de largo plazo como diabetes, presión alta o artritis. La actividad también les ayuda.",
          "Adultos mayores, que además se benefician de ejercicios de equilibrio",
        ],
        howOften: "Trate de hacer 150 minutos a la semana de actividad moderada, más ejercicios de fuerza 2 días a la semana",
        whatToDo: [
          "Actividad moderada quiere decir que respira más rápido, pero todavía puede hablar. Caminar a paso rápido, bailar, nadar, andar en bicicleta y trabajar en el jardín cuentan.",
          "Divídalo: 30 minutos al día, 5 días a la semana, o incluso 10 minutos a la vez. Subir escaleras y caminar más durante el día también cuentan.",
          "Haga ejercicios de fuerza 2 días a la semana. Use pesas ligeras, ligas de ejercicio, latas de comida o su propio cuerpo (como lagartijas contra la pared o pararse y sentarse en una silla).",
          "Empiece despacio. Si no ha hecho actividad física en un tiempo, comience con 5 a 10 minutos y agregue unos minutos cada semana.",
          "Evite el calor de Houston: camine temprano en la mañana o al atardecer, o vaya a un centro comercial, gimnasio o centro comunitario con aire acondicionado.",
          "Tome agua antes, durante y después de la actividad, y use ropa ligera y holgada. Pare y refrésquese si siente mareo, náuseas, mucho cansancio o dolor de cabeza.",
          "Si es adulto mayor, agregue ejercicios de equilibrio, como tai chi o pararse en un pie mientras se sostiene del mostrador.",
        ],
        whatToExpect: [
          "Es posible que duerma mejor y sienta menos estrés en las primeras semanas.",
          "Es normal sentir un poco de dolor en los músculos al empezar. Debe mejorar en uno o dos días.",
          "En unos meses, la presión, el azúcar y la fuerza suelen mejorar, y las tareas de cada día se hacen más fáciles.",
        ],
        talkToUs: [
          "Siente dolor, presión u opresión en el pecho, le falta mucho el aire o siente que se va a desmayar al hacer actividad. Pare de inmediato, y llame al 911 si no se le quita pronto.",
          "Tiene una enfermedad del corazón, diabetes u otra condición y quiere empezar algo más fuerte que caminar.",
          "Tiene dolor en las articulaciones o una lesión que no le deja moverse.",
          "Quiere ideas para un plan que vaya con su cuerpo, su horario y su presupuesto.",
        ],
      },
    },
    basis: [
      "Physical Activity Guidelines for Americans, 2nd edition",
      "CDC: Heat and Health (preventing heat-related illness)",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_healthy_weight",
    education: {
      en: {
        title: "Reaching a healthy weight",
        summary: "A healthy weight helps protect you from diabetes, heart disease, high blood pressure, sleep apnea, and joint pain. You don't need to reach a perfect number. Losing even a small amount of weight can make a big difference, and weight is not only about willpower: genes, sleep, stress, and some medicines play a part too.",
        whoFor: [
          "Adults with a body mass index (BMI) of 25 or more",
          "People with prediabetes, diabetes, high blood pressure, high cholesterol, or sleep apnea",
          "Anyone who wants to stop gaining weight",
        ],
        howOften: "Every day, one small step at a time. Check your weight about once a week.",
        whatToDo: [
          "Set a small goal. Losing 5 to 10% of your weight helps your health. For someone who weighs 200 pounds, that is 10 to 20 pounds.",
          "Aim to lose about 1 to 2 pounds a week. Slow and steady is easier to keep off.",
          "Make one change at a time, like drinking water instead of soda, using a smaller plate, or skipping second helpings.",
          "Fill half your plate with vegetables and have some protein at each meal to help you stay full longer.",
          "Move more. Work up to 150 minutes or more of activity a week. Activity also helps you keep the weight off.",
          "Get 7 or more hours of sleep and find healthy ways to handle stress. Both affect how hungry you feel.",
          "Write down what you eat and drink, and your weight, in a notebook or a phone app. It helps you see patterns.",
        ],
        whatToExpect: [
          "Weight often comes off faster in the first few weeks, then slows down. That is normal.",
          "Some weeks your weight may not change. Keep going. Your healthy habits are still helping.",
          "Your blood pressure, blood sugar, energy, and joint pain may get better even before you reach your goal.",
        ],
        talkToUs: [
          "You have tried to lose weight and it has not worked. There are medical weight-loss options, including medicines and surgery, that may be right for you.",
          "You are gaining or losing weight without trying, or you think a medicine is making you gain weight.",
          "Eating feels out of control, or you skip meals or make yourself throw up to control your weight.",
          "You would like to see a dietitian or join a weight-management program.",
        ],
      },
      es: {
        title: "Cómo llegar a un peso saludable",
        summary: "Un peso saludable le ayuda a protegerse de la diabetes, las enfermedades del corazón, la presión alta, la apnea del sueño y el dolor de articulaciones. No tiene que llegar a un número perfecto. Bajar aunque sea un poco de peso puede hacer una gran diferencia, y el peso no depende solo de la fuerza de voluntad: los genes, el sueño, el estrés y algunas medicinas también influyen.",
        whoFor: [
          "Adultos con un índice de masa corporal (IMC) de 25 o más",
          "Personas con prediabetes, diabetes, presión alta, colesterol alto o apnea del sueño",
          "Quien quiera dejar de subir de peso",
        ],
        howOften: "Todos los días, un pasito a la vez. Pésese más o menos una vez a la semana.",
        whatToDo: [
          "Póngase una meta pequeña. Bajar del 5 al 10% de su peso ayuda a su salud. Para una persona que pesa 200 libras, son de 10 a 20 libras.",
          "Trate de bajar de 1 a 2 libras por semana. Poco a poco es más fácil no volver a subir.",
          "Haga un cambio a la vez, como tomar agua en vez de refresco, usar un plato más pequeño o no servirse dos veces.",
          "Llene la mitad del plato con verduras y coma algo de proteína en cada comida para que el hambre tarde más en volver.",
          "Muévase más. Poco a poco llegue a 150 minutos o más de actividad por semana. La actividad también le ayuda a no recuperar el peso.",
          "Duerma 7 horas o más y busque formas sanas de manejar el estrés. Los dos influyen en el hambre.",
          "Anote lo que come y toma, y su peso, en una libreta o en una aplicación del celular. Le ayuda a ver patrones.",
        ],
        whatToExpect: [
          "Muchas veces el peso baja más rápido las primeras semanas y luego más despacio. Es normal.",
          "Habrá semanas en que el peso no cambie. Siga adelante. Sus hábitos saludables le siguen ayudando.",
          "La presión, el azúcar, la energía y el dolor de articulaciones pueden mejorar aun antes de llegar a su meta.",
        ],
        talkToUs: [
          "Ha tratado de bajar de peso y no ha funcionado. Hay opciones médicas para bajar de peso, como medicinas y cirugía, que podrían ser buenas para usted.",
          "Está subiendo o bajando de peso sin querer, o cree que una medicina le está haciendo subir de peso.",
          "Siente que pierde el control con la comida, o se salta comidas o se provoca el vómito para controlar su peso.",
          "Quiere ver a un nutricionista o entrar a un programa para controlar el peso.",
        ],
      },
    },
    basis: [
      "USPSTF: Behavioral Weight Loss Interventions to Prevent Obesity-Related Morbidity and Mortality in Adults (2018)",
      "CDC: Healthy Weight and Losing Weight",
      "NIDDK: Weight Management",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_sleep",
    education: {
      en: {
        title: "Better sleep",
        summary: "Good sleep is as important for your health as healthy food and exercise. Adults need 7 or more hours of sleep each night. Poor sleep can raise your risk of high blood pressure, diabetes, weight gain, depression, and accidents.",
        whoFor: [
          "Everyone, at any age",
          "People who have trouble falling asleep or staying asleep",
          "People who snore loudly or feel tired during the day",
        ],
        howOften: "Aim for 7 or more hours every night",
        whatToDo: [
          "Go to bed and get up at the same time every day, even on weekends.",
          "Keep your bedroom dark, quiet, and cool. Use your bed for sleep, not for TV or work.",
          "Put away your phone and turn off screens 30 to 60 minutes before bed. Try a calm routine, like a warm shower, reading, or prayer.",
          "Avoid caffeine (coffee, tea, soda, and energy drinks) after early afternoon. Avoid alcohol and big meals close to bedtime.",
          "Get outside light and move your body during the day, but finish hard exercise a few hours before bed.",
          "If you nap, keep it short (under 30 minutes) and early in the afternoon.",
          "If you can't fall asleep after about 20 minutes, get up and do something quiet in dim light. Go back to bed when you feel sleepy.",
        ],
        whatToExpect: [
          "New sleep habits can take 2 to 4 weeks to make a difference. Stick with them.",
          "Some nights will still be hard. One bad night is not a problem. Keep your routine.",
          "With better sleep, you may notice more energy, a better mood, and clearer thinking.",
        ],
        talkToUs: [
          "You snore loudly, choke or gasp in your sleep, or someone has seen you stop breathing. These can be signs of sleep apnea, a common problem that can be treated.",
          "You feel very sleepy during the day, or you get drowsy while driving.",
          "You have trouble falling or staying asleep most nights for more than a few weeks. There is a proven treatment for this that does not use medicine.",
          "You want to take a sleep aid, even one you can buy without a prescription. Some are not safe, especially for older adults.",
        ],
      },
      es: {
        title: "Dormir mejor",
        summary: "Dormir bien es tan importante para la salud como comer bien y hacer ejercicio. Los adultos necesitan dormir 7 horas o más cada noche. Dormir mal puede aumentar el riesgo de presión alta, diabetes, aumento de peso, depresión y accidentes.",
        whoFor: [
          "Todas las personas, a cualquier edad",
          "Personas que tienen problemas para dormirse o para seguir durmiendo",
          "Personas que roncan fuerte o que sienten cansancio durante el día",
        ],
        howOften: "Trate de dormir 7 horas o más todas las noches",
        whatToDo: [
          "Acuéstese y levántese a la misma hora todos los días, aun los fines de semana.",
          "Mantenga su cuarto oscuro, en silencio y fresco. Use la cama para dormir, no para ver televisión o trabajar.",
          "Guarde el celular y apague las pantallas de 30 a 60 minutos antes de dormir. Pruebe una rutina tranquila, como un baño tibio, leer u orar.",
          "Evite la cafeína (café, té, refrescos y bebidas energéticas) después de las primeras horas de la tarde. Evite el alcohol y las comidas grandes cerca de la hora de dormir.",
          "Salga a la luz del día y muévase durante el día, pero termine el ejercicio fuerte unas horas antes de acostarse.",
          "Si toma siesta, que sea corta (menos de 30 minutos) y temprano en la tarde.",
          "Si no se duerme después de unos 20 minutos, levántese y haga algo tranquilo con poca luz. Vuelva a la cama cuando tenga sueño.",
        ],
        whatToExpect: [
          "Los nuevos hábitos de sueño pueden tardar de 2 a 4 semanas en hacer efecto. No se rinda.",
          "Algunas noches todavía serán difíciles. Una mala noche no es un problema. Siga con su rutina.",
          "Al dormir mejor, puede notar más energía, mejor ánimo y que piensa con más claridad.",
        ],
        talkToUs: [
          "Ronca fuerte, se ahoga o le falta el aire mientras duerme, o alguien ha visto que deja de respirar. Pueden ser señales de apnea del sueño, un problema común que tiene tratamiento.",
          "Tiene mucho sueño durante el día o le da sueño al manejar.",
          "Le cuesta dormirse o seguir durmiendo la mayoría de las noches por más de unas semanas. Hay un tratamiento comprobado para esto que no usa medicinas.",
          "Quiere tomar algo para dormir, aunque sea sin receta. Algunos no son seguros, sobre todo para los adultos mayores.",
        ],
      },
    },
    basis: [
      "AASM/SRS consensus statement: Recommended Amount of Sleep for a Healthy Adult (2015)",
      "AASM clinical practice guideline: Behavioral and Psychological Treatments for Chronic Insomnia (2021)",
      "CDC: Sleep and Sleep Disorders",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_quit_smoking",
    education: {
      en: {
        title: "Quitting smoking & vaping",
        summary: "Quitting smoking is the best thing you can do for your health, at any age. Smoking harms almost every part of your body, and vaping is not safe either. Quitting is hard, but free help and medicines can greatly improve your chances.",
        whoFor: [
          "Anyone who smokes cigarettes, cigars, or hookah, or who chews tobacco",
          "Anyone who vapes or uses e-cigarettes",
          "People who want to protect their family from secondhand smoke",
        ],
        howOften: "Start today: pick a quit date within the next 2 weeks",
        whatToDo: [
          "Pick a quit date in the next 2 weeks. Tell your family and friends so they can support you.",
          "Call 1-800-QUIT-NOW (1-800-784-8669) for free help. It is also the Texas quitline. A coach can help you make a plan, in English or Spanish. You can also visit smokefree.gov.",
          "Ask us about medicines that help with cravings. Using medicine and coaching together works best.",
          "Know your triggers, like coffee, meals, alcohol, stress, or being around people who smoke. Plan what you will do instead.",
          "Get rid of all cigarettes, vapes, lighters, and ashtrays. Keep your home and car smoke-free.",
          "When a craving hits, wait it out. It usually passes in a few minutes. Drink water, take a walk, breathe deeply, or chew sugar-free gum.",
          "If you slip, don't give up. Most people try several times before they quit for good. Each try teaches you something.",
        ],
        whatToExpect: [
          "Cravings, feeling cranky, trouble sleeping, and feeling hungrier are common in the first few weeks. They get better with time.",
          "Within weeks, your breathing and blood flow start to improve. Coughing often gets better over the next few months.",
          "Your risk of heart attack and stroke starts going down soon after you quit, and your cancer risk keeps dropping year after year.",
        ],
        talkToUs: [
          "You are ready to quit, or you want to try a medicine to help.",
          "You tried before and started again. We can try a different plan.",
          "You are 50 to 80 years old and smoked a lot in the past or still smoke. Ask about a lung cancer screening test.",
          "You feel very sad or nervous while you are quitting.",
        ],
      },
      es: {
        title: "Cómo dejar de fumar y de vapear",
        summary: "Dejar de fumar es lo mejor que puede hacer por su salud, a cualquier edad. Fumar daña casi todas las partes del cuerpo, y vapear tampoco es seguro. Dejarlo es difícil, pero hay ayuda gratis y medicinas que aumentan mucho sus probabilidades de lograrlo.",
        whoFor: [
          "Quien fume cigarros, puros o narguile (hookah), o masque tabaco",
          "Quien use vapeadores o cigarrillos electrónicos",
          "Quien quiera proteger a su familia del humo de segunda mano",
        ],
        howOften: "Empiece hoy: escoja una fecha para dejarlo dentro de las próximas 2 semanas",
        whatToDo: [
          "Escoja una fecha para dejar de fumar en las próximas 2 semanas. Avísele a su familia y a sus amistades para que le apoyen.",
          "Llame gratis al 1-800-QUIT-NOW (1-800-784-8669). También es la línea de Texas para dejar de fumar. Un consejero le ayuda a hacer un plan, en español o en inglés. También puede visitar espanol.smokefree.gov.",
          "Pregúntenos por las medicinas que ayudan a controlar las ganas de fumar. Usar medicina y consejería juntas funciona mejor.",
          "Conozca lo que le da ganas de fumar, como el café, las comidas, el alcohol, el estrés o estar con personas que fuman. Planee qué hará en su lugar.",
          "Tire todos los cigarros, vapeadores, encendedores y ceniceros. No permita que se fume en su casa ni en su carro.",
          "Cuando le den ganas, aguante unos minutos. Casi siempre se pasan pronto. Tome agua, salga a caminar, respire hondo o masque chicle sin azúcar.",
          "Si vuelve a fumar, no se rinda. La mayoría de las personas lo intentan varias veces antes de dejarlo para siempre. Cada intento le enseña algo.",
        ],
        whatToExpect: [
          "Es común tener ganas de fumar, mal humor, problemas para dormir y más hambre las primeras semanas. Todo eso mejora con el tiempo.",
          "En pocas semanas, la respiración y la circulación empiezan a mejorar. La tos suele mejorar en los meses siguientes.",
          "El riesgo de infarto y de derrame cerebral empieza a bajar poco después de dejar de fumar, y el riesgo de cáncer sigue bajando año tras año.",
        ],
        talkToUs: [
          "Ya quiere dejar de fumar, o quiere probar una medicina que le ayude.",
          "Ya lo intentó antes y volvió a fumar. Podemos probar otro plan.",
          "Tiene entre 50 y 80 años y fumó mucho en el pasado o todavía fuma. Pregunte por la prueba para detectar el cáncer de pulmón.",
          "Siente mucha tristeza o muchos nervios mientras deja de fumar.",
        ],
      },
    },
    basis: [
      "USPSTF: Interventions for Tobacco Smoking Cessation in Adults (2021)",
      "CDC: How to Quit Smoking",
      "Smokefree.gov (National Cancer Institute)",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_alcohol",
    education: {
      en: {
        title: "Alcohol and your health",
        summary: "Alcohol can affect your health, even in small amounts. Too much raises your risk of high blood pressure, liver disease, several kinds of cancer, falls, and accidents. For your health, drinking less is better than drinking more, and not drinking at all is the safest choice.",
        whoFor: [
          "All adults who drink alcohol",
          "People who take medicines or who have liver disease, diabetes, high blood pressure, or depression",
          "Older adults, who often feel the effects of alcohol more",
          "Anyone who is worried about their own drinking or a loved one's",
        ],
        howOften: "If you drink, have no more than 1 drink a day for women or 2 for men. Less is better.",
        whatToDo: [
          "Know what one drink is: 12 ounces of regular beer, 5 ounces of wine, or 1.5 ounces of liquor (like tequila, whiskey, rum, or vodka). Many mixed drinks and cocktails have more than one.",
          "Don't save up drinks for the weekend. Having 4 or more drinks at one time (women) or 5 or more (men) is risky.",
          "Some people should not drink at all: people who are pregnant or trying to get pregnant, anyone under 21 or about to drive, people taking medicines that don't mix with alcohol, and people recovering from alcohol problems.",
          "Have alcohol-free days each week, and drink a glass of water between drinks.",
          "At parties, try alcohol-free drinks, like sparkling water with lime or a mocktail.",
          "Never drink and drive. Plan a safe ride home.",
          "Watch for signs of a problem: you drink more or longer than you planned, you can't cut down, you crave alcohol, drinking causes trouble at home or work, or you feel shaky, sweaty, or nervous when it wears off.",
        ],
        whatToExpect: [
          "When people cut back, many sleep better, have more energy, and save money.",
          "Blood pressure and liver tests often get better within weeks to months.",
          "Help works. Counseling, support groups, and medicines help many people drink less or stop.",
        ],
        talkToUs: [
          "You want to cut back or stop and need help. Treatment works, and it is private.",
          "You drink a lot every day. Don't stop all at once on your own. Stopping suddenly can be dangerous, and we can help you do it safely.",
          "Someone in your family is worried about your drinking, or you are worried about someone else's drinking.",
          "You take medicines and aren't sure if alcohol is safe with them.",
        ],
      },
      es: {
        title: "El alcohol y su salud",
        summary: "El alcohol puede afectar su salud, aun en pequeñas cantidades. Tomar de más aumenta el riesgo de presión alta, enfermedad del hígado, varios tipos de cáncer, caídas y accidentes. Para su salud, tomar menos es mejor que tomar más, y no tomar nada es lo más seguro.",
        whoFor: [
          "Todos los adultos que toman alcohol",
          "Personas que toman medicinas o que tienen enfermedad del hígado, diabetes, presión alta o depresión",
          "Adultos mayores, a quienes el alcohol muchas veces les afecta más",
          "Quien se preocupe por cuánto toma, o por cuánto toma un ser querido",
        ],
        howOften: "Si toma, no tome más de 1 bebida al día si es mujer ni más de 2 si es hombre. Menos es mejor.",
        whatToDo: [
          "Sepa cuánto es una bebida: 12 onzas de cerveza normal, 5 onzas de vino o 1.5 onzas de licor (como tequila, whisky, ron o vodka). Muchas bebidas preparadas y cocteles tienen más de una.",
          "No junte las bebidas para el fin de semana. Tomar 4 o más bebidas en una sola ocasión (mujeres) o 5 o más (hombres) es peligroso.",
          "Algunas personas no deben tomar nada: quienes están embarazadas o quieren embarazarse, los menores de 21 años, quien va a manejar, quien toma medicinas que no se deben mezclar con alcohol y quien se está recuperando de problemas con el alcohol.",
          "Tenga días sin alcohol cada semana, y tome un vaso de agua entre una bebida y otra.",
          "En las fiestas, pruebe bebidas sin alcohol, como agua mineral con limón o un coctel sin alcohol.",
          "Nunca maneje después de tomar. Planee cómo regresar a casa de forma segura.",
          "Fíjese en las señales de un problema: toma más o por más tiempo de lo que pensaba, no puede tomar menos, siente muchas ganas de tomar, el alcohol le causa problemas en la casa o el trabajo, o le dan temblores, sudor o nervios cuando se le pasa el efecto.",
        ],
        whatToExpect: [
          "Al tomar menos, muchas personas duermen mejor, tienen más energía y ahorran dinero.",
          "La presión y los análisis del hígado muchas veces mejoran en semanas o meses.",
          "La ayuda funciona. La consejería, los grupos de apoyo y las medicinas ayudan a muchas personas a tomar menos o a dejarlo.",
        ],
        talkToUs: [
          "Quiere tomar menos o dejar de tomar y necesita ayuda. El tratamiento funciona y es confidencial.",
          "Toma mucho todos los días. No lo deje de golpe por su cuenta. Dejarlo de repente puede ser peligroso, y le podemos ayudar a hacerlo de forma segura.",
          "Alguien de su familia está preocupado por cómo toma, o a usted le preocupa cómo toma otra persona.",
          "Toma medicinas y no sabe si es seguro mezclarlas con alcohol.",
        ],
      },
    },
    basis: [
      "NIAAA: Rethinking Drinking",
      "Dietary Guidelines for Americans, 2020–2025 (alcohol guidance)",
      "U.S. Surgeon General's Advisory on Alcohol and Cancer Risk (2025)",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_stress",
    education: {
      en: {
        title: "Stress & emotional health",
        summary: "Everyone feels stress, worry, or sadness sometimes. A little stress is normal, but too much for too long can hurt your sleep, your body, and your relationships. Taking care of your emotional health is just as important as taking care of your body.",
        whoFor: [
          "Everyone, at any age",
          "People going through hard times, like money problems, a loss, an illness, a move, or caring for a loved one",
          "Anyone who feels worried, down, or overwhelmed",
        ],
        howOften: "Every day: take a few minutes for yourself",
        whatToDo: [
          "Move your body. A short walk can ease stress and lift your mood.",
          "Try slow breathing: breathe in through your nose while you count to 4, then out through your mouth while you count to 6. Repeat for a few minutes.",
          "Talk with someone you trust, like a family member, a friend, or a faith leader. You don't have to handle things alone.",
          "Keep a routine: regular times to sleep and eat, and time for things you enjoy.",
          "Take breaks from the news and social media.",
          "Break big problems into small steps, and focus on what you can control.",
          "Try not to use alcohol, tobacco, or drugs to cope. They can make stress and your mood worse.",
        ],
        whatToExpect: [
          "Small daily habits can help you feel calmer within a few weeks.",
          "Depression and anxiety are common medical conditions, not a weakness. Treatment, like counseling and sometimes medicine, helps most people feel better.",
          "What you share with us is private.",
        ],
        talkToUs: [
          "You feel sad, hopeless, nervous, or worried most days for 2 weeks or more.",
          "Stress makes it hard to sleep, eat, work, or enjoy things you used to like.",
          "You are using alcohol or drugs to cope, or you feel you can't control your worry or anger.",
          "You have thoughts of hurting yourself or ending your life. Don't wait: call or text 988 (the Suicide & Crisis Lifeline) any time, day or night. It is free and private, and help is available in Spanish. In an emergency, call 911.",
        ],
      },
      es: {
        title: "El estrés y la salud emocional",
        summary: "Todos sentimos estrés, preocupación o tristeza a veces. Un poco de estrés es normal, pero demasiado y por mucho tiempo puede afectar el sueño, el cuerpo y las relaciones con los demás. Cuidar su salud emocional es tan importante como cuidar su cuerpo.",
        whoFor: [
          "Todas las personas, a cualquier edad",
          "Personas que pasan por momentos difíciles, como problemas de dinero, una pérdida, una enfermedad, una mudanza o el cuidado de un ser querido",
          "Quien sienta preocupación, tristeza o que ya no puede más",
        ],
        howOften: "Todos los días: tome unos minutos para usted",
        whatToDo: [
          "Mueva el cuerpo. Una caminata corta puede bajar el estrés y mejorar el ánimo.",
          "Pruebe respirar despacio: tome aire por la nariz mientras cuenta hasta 4 y suéltelo por la boca mientras cuenta hasta 6. Repita por unos minutos.",
          "Hable con alguien de confianza, como un familiar, una amistad o un líder de su comunidad de fe. No tiene por qué cargar con todo sin ayuda.",
          "Mantenga una rutina: horas fijas para dormir y comer, y tiempo para lo que le gusta.",
          "Tome descansos de las noticias y las redes sociales.",
          "Divida los problemas grandes en pasos pequeños y enfóquese en lo que sí puede controlar.",
          "Trate de no usar alcohol, tabaco ni drogas para sobrellevar el estrés. Pueden empeorar el estrés y el ánimo.",
        ],
        whatToExpect: [
          "Los hábitos pequeños de cada día le pueden ayudar a sentir más calma en pocas semanas.",
          "La depresión y la ansiedad son condiciones médicas comunes, no una debilidad. El tratamiento, como la consejería y a veces medicinas, ayuda a la mayoría de las personas a sentirse mejor.",
          "Lo que nos cuente es confidencial.",
        ],
        talkToUs: [
          "Siente tristeza, falta de esperanza, nervios o preocupación casi todos los días por 2 semanas o más.",
          "El estrés no le deja dormir, comer, trabajar o disfrutar lo que antes le gustaba.",
          "Está usando alcohol o drogas para sobrellevar las cosas, o siente que no puede controlar su preocupación o su enojo.",
          "Tiene pensamientos de hacerse daño o de quitarse la vida. No espere: llame o envíe un mensaje de texto al 988 (Línea de Prevención del Suicidio y Crisis) a cualquier hora, de día o de noche. Es gratis y confidencial, y hay ayuda en español. En una emergencia, llame al 911.",
        ],
      },
    },
    basis: [
      "CDC: Coping with Stress",
      "NIMH: Caring for Your Mental Health",
      "988 Suicide & Crisis Lifeline (SAMHSA)",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_fall_prevention",
    education: {
      en: {
        title: "Preventing falls",
        summary: "Falls are a common cause of injury in older adults. About 1 in 4 adults age 65 and older falls each year. But falling is not a normal part of aging, and most falls can be prevented with simple changes to your home, your body, and your habits.",
        whoFor: [
          "Adults 65 and older",
          "Anyone who has fallen in the past year or feels unsteady when standing or walking",
          "People who worry about falling",
          "People who take medicines that can cause dizziness or sleepiness",
        ],
        howOften: "Every day. Check your fall risk with us at least once a year.",
        whatToDo: [
          "Do exercises that build strength and balance, like tai chi, walking, or chair exercises. Ask us about a class or physical therapy.",
          "Once a year, bring all your medicines to us, including vitamins and ones you buy without a prescription. Some can make you dizzy or sleepy.",
          "Get your eyes checked every year, and keep your glasses up to date.",
          "Wear sturdy shoes with non-slip soles and low heels. At home, wear non-slip house shoes that fit well and have a back, not socks, loose slippers, or flip-flops.",
          "Make your home safer: clear loose rugs, clutter, and cords from walkways, and keep things you use often within easy reach.",
          "Add grab bars in the shower and next to the toilet, railings on both sides of stairs, and night lights in halls and the bathroom.",
          "Stand up slowly, especially after lying down or sitting a long time. Keep a phone with you so you can call for help if you fall.",
        ],
        whatToExpect: [
          "Balance and strength usually get better within a few months of regular exercise.",
          "Many people feel more confident and do more once they feel steadier.",
          "Small home changes take little time and can prevent a serious injury, like a broken hip.",
        ],
        talkToUs: [
          "You have fallen, even if you were not hurt. If you hit your head, especially if you take a blood thinner, get medical care right away.",
          "You feel dizzy or unsteady, or it is hard to get up from a chair.",
          "You are afraid of falling and do less because of it.",
          "A medicine makes you dizzy or sleepy. Don't stop it on your own. Call us.",
        ],
      },
      es: {
        title: "Cómo prevenir caídas",
        summary: "Las caídas son una causa común de lesiones en los adultos mayores. Cerca de 1 de cada 4 personas de 65 años o más se cae cada año. Pero caerse no es parte normal de envejecer, y la mayoría de las caídas se pueden prevenir con cambios sencillos en su casa, su cuerpo y sus costumbres.",
        whoFor: [
          "Adultos de 65 años o más",
          "Quien se haya caído en el último año o sienta inestabilidad al pararse o caminar",
          "Personas que tienen miedo de caerse",
          "Personas que toman medicinas que pueden causar mareo o sueño",
        ],
        howOften: "Todos los días. Revise con nosotros su riesgo de caídas por lo menos una vez al año.",
        whatToDo: [
          "Haga ejercicios de fuerza y equilibrio, como tai chi, caminar o ejercicios en silla. Pregúntenos por una clase o por terapia física.",
          "Una vez al año, tráiganos todas sus medicinas, incluso las vitaminas y las que compra sin receta. Algunas pueden causar mareo o sueño.",
          "Hágase revisar la vista cada año y mantenga sus lentes al día.",
          "Use zapatos firmes, con suela que no resbale y tacón bajo. En casa, use pantuflas antideslizantes que le queden bien y que tengan talón, no calcetines, pantuflas flojas ni chanclas.",
          "Haga su casa más segura: quite de los pasillos los tapetes sueltos, las cosas tiradas y los cables, y tenga a la mano lo que usa seguido.",
          "Ponga barras de apoyo en la regadera y junto al inodoro, pasamanos a los dos lados de las escaleras y lucecitas de noche en los pasillos y el baño.",
          "Levántese despacio, sobre todo si ha estado mucho tiempo en la cama o en una silla. Lleve un teléfono consigo para pedir ayuda si se cae.",
        ],
        whatToExpect: [
          "El equilibrio y la fuerza suelen mejorar en unos meses de ejercicio regular.",
          "Muchas personas sienten más confianza y hacen más cosas cuando se sienten más firmes.",
          "Los cambios pequeños en casa toman poco tiempo y pueden evitar una lesión grave, como una fractura de cadera.",
        ],
        talkToUs: [
          "Se ha caído, aunque no se haya lastimado. Si se golpeó la cabeza, sobre todo si toma un anticoagulante (medicina que hace la sangre más ligera), busque atención médica de inmediato.",
          "Siente mareo o inestabilidad, o le cuesta levantarse de una silla.",
          "Tiene miedo de caerse y por eso hace menos cosas.",
          "Una medicina le causa mareo o sueño. No la deje por su cuenta. Llámenos.",
        ],
      },
    },
    basis: [
      "CDC STEADI (Stopping Elderly Accidents, Deaths & Injuries)",
      "USPSTF: Interventions to Prevent Falls in Community-Dwelling Older Adults (2024)",
    ],
  },
  // ---------------------------------------------------------------------------------------------------
  {
    key: "w_sun_safety",
    education: {
      en: {
        title: "Sun safety & skin checks",
        summary: "Skin cancer is the most common cancer in the United States, and most cases are linked to the sun's UV rays. In Houston the sun is strong all year, even on cloudy days. People of every skin color can get skin cancer, and finding it early makes it easier to treat.",
        whoFor: [
          "Everyone, of every skin color",
          "People who work or spend a lot of time outdoors",
          "People with fair skin, many moles, or a family history of skin cancer",
          "Anyone who has had skin cancer before",
        ],
        howOften: "Protect your skin every day you are outside, and check your skin once a month",
        whatToDo: [
          "Use a broad-spectrum, water-resistant sunscreen with SPF 30 or higher on all skin that clothes don't cover.",
          "Put it on 15 minutes before you go outside. Use enough (about a shot glass full for your whole body), and put more on every 2 hours or after swimming or sweating.",
          "Stay in the shade, especially from 10 a.m. to 4 p.m., when the sun is strongest. If your shadow is shorter than you are, find shade.",
          "Wear a wide-brim hat, sunglasses that block UV rays, and long sleeves and pants when you can. Light, loose clothes help in the heat.",
          "Don't use tanning beds.",
          "Check your skin once a month in good light, using a mirror. Look everywhere, including your scalp, palms, the soles of your feet, and under your nails.",
          "Use the ABCDEs to spot a mole that may be a problem. A: one half doesn't match the other. B: the edges are ragged or blurry. C: it has more than one color. D: it is bigger than a pencil eraser. E: it is changing in size, shape, or color.",
        ],
        whatToExpect: [
          "Sunscreen and shade lower your risk of sunburn, skin cancer, early wrinkles, and dark spots.",
          "Most moles are harmless. If we see a spot that worries us, we may send you to a skin doctor (dermatologist) or take a small sample.",
          "Skin cancer found early can almost always be treated successfully.",
        ],
        talkToUs: [
          "You have a mole or spot with any of the ABCDE signs, or one that looks different from your other moles.",
          "You have a sore that doesn't heal in a few weeks, or a spot that bleeds, itches, or crusts over.",
          "You notice a new dark line under a nail, or a new spot on your palm or the sole of your foot.",
          "You have had skin cancer before, or it runs in your family, and you want to know if you need regular skin exams.",
        ],
      },
      es: {
        title: "Protección del sol y revisión de la piel",
        summary: "El cáncer de piel es el cáncer más común en los Estados Unidos, y la mayoría de los casos tiene que ver con los rayos UV del sol. En Houston el sol es fuerte todo el año, aun en días nublados. Las personas de cualquier color de piel pueden tener cáncer de piel, y encontrarlo a tiempo hace que sea más fácil de tratar.",
        whoFor: [
          "Todas las personas, de cualquier color de piel",
          "Quien trabaje o pase mucho tiempo al aire libre",
          "Personas de piel clara, con muchos lunares o con familiares que han tenido cáncer de piel",
          "Quien ya haya tenido cáncer de piel",
        ],
        howOften: "Proteja su piel cada día que esté afuera, y revise su piel una vez al mes",
        whatToDo: [
          "Use un protector solar (bloqueador) de amplio espectro, resistente al agua y con SPF 30 o más en toda la piel que no cubra la ropa.",
          "Póngaselo 15 minutos antes de salir. Use suficiente (más o menos un vasito pequeño lleno para todo el cuerpo), y vuelva a ponérselo cada 2 horas o después de nadar o sudar.",
          "Quédese en la sombra, sobre todo de 10 de la mañana a 4 de la tarde, cuando el sol es más fuerte. Si su sombra es más corta que usted, busque la sombra.",
          "Use sombrero de ala ancha, lentes de sol que bloqueen los rayos UV y, cuando pueda, manga larga y pantalón largo. La ropa ligera y holgada ayuda con el calor.",
          "No use camas de bronceado.",
          "Revise su piel una vez al mes con buena luz y un espejo. Revise todo, incluso el cuero cabelludo, las palmas de las manos, las plantas de los pies y debajo de las uñas.",
          "Use el ABCDE para detectar un lunar que podría ser un problema. A (asimetría): una mitad no es igual a la otra. B (bordes): las orillas son disparejas o borrosas. C (color): tiene más de un color. D (diámetro): es más grande que el borrador de un lápiz. E (evolución): está cambiando de tamaño, forma o color.",
        ],
        whatToExpect: [
          "El protector solar y la sombra bajan el riesgo de quemaduras, cáncer de piel, arrugas antes de tiempo y manchas oscuras.",
          "La mayoría de los lunares no son peligrosos. Si vemos una mancha que nos preocupa, podemos enviarle con un dermatólogo (doctor de la piel) o tomar una muestra pequeña.",
          "El cáncer de piel que se encuentra a tiempo casi siempre se puede tratar con éxito.",
        ],
        talkToUs: [
          "Tiene un lunar o una mancha con alguna de las señales del ABCDE, o que se ve diferente a sus otros lunares.",
          "Tiene una llaga que no sana en unas semanas, o una mancha que sangra, da comezón o forma costra.",
          "Nota una raya oscura nueva debajo de una uña, o una mancha nueva en la palma de la mano o en la planta del pie.",
          "Ya tuvo cáncer de piel o hay casos en su familia, y quiere saber si necesita revisiones de la piel con regularidad.",
        ],
      },
    },
    basis: [
      "American Academy of Dermatology: sun protection and the ABCDEs of melanoma",
      "CDC: Sun Safety",
      "USPSTF: Skin Cancer Prevention: Behavioral Counseling (2018)",
    ],
  },
];

/** Points the reviewer should double-check (judgment calls). */
export const WELLNESS_LIVING_NOTES: Record<string, string[]> = {
  w_healthy_eating: [
    "Kept general (plate method, whole foods, less added sugar and salt) so it fits both the 2020–2025 and the newer 2025–2030 Dietary Guidelines; check the 'lean protein' wording against the newest edition.",
    "Beans, lentils, and fruit are encouraged; patients with advanced kidney disease may need limits, which is covered only by the 'talk with us' line.",
    "Cultural food examples (Latino, Middle Eastern) are meant to match the local patient mix; adjust if needed.",
  ],
  w_physical_activity: [
    "'Drink water' heat advice is general; patients with heart failure or on fluid limits may need different advice.",
    "Chest-pain line says to stop and call 911 if it doesn't go away quickly; confirm this wording.",
  ],
  w_healthy_weight: [
    "Uses BMI 25+ as the cut-off; some guidelines use a lower cut-off (23) for patients of Asian descent.",
    "Mentions medicines and surgery as medical options (no drug names); confirm the practice wants surgery mentioned.",
  ],
  w_sleep: [
    "The insomnia line points to a 'proven treatment without medicine' (CBT-I) without naming it; confirm the practice can refer for it.",
    "The 'sleep aids not safe for older adults' line reflects Beers Criteria concerns about sedating over-the-counter antihistamines.",
  ],
  w_quit_smoking: [
    "National Spanish quitline 1-855-DÉJELO-YA (1-855-335-3569) left out per the phone-number rule; consider adding it to the Spanish version.",
    "Treats vaping as not safe rather than as a way to quit (USPSTF: not enough evidence that e-cigarettes help adults quit); confirm this matches the practice's stance.",
  ],
  w_alcohol: [
    "Daily limits (no more than 1 for women, 2 for men) come from the 2020–2025 Dietary Guidelines; check against the newest edition's wording.",
    "SAMHSA National Helpline (free, 24/7, Spanish available) left out per the phone-number rule; consider adding it.",
    "Includes a warning not to stop heavy daily drinking suddenly (withdrawal risk).",
  ],
  w_stress: [
    "The self-harm line sends patients straight to 988 / 911 rather than the clinic; confirm this fits the practice's crisis workflow.",
    "Consider adding a line about the practice's own behavioral health (BHI) program.",
  ],
  w_fall_prevention: [
    "Vitamin D for fall prevention is deliberately not mentioned (USPSTF 2024 recommends against it for older adults living at home).",
    "House-shoe wording allows for households that take shoes off indoors.",
  ],
  w_sun_safety: [
    "USPSTF finds not enough evidence for routine skin-cancer screening by clinicians; the monthly self-check advice follows the American Academy of Dermatology.",
    "Shade hours are 10 a.m.–4 p.m. (CDC); the AAD uses 10 a.m.–2 p.m.",
  ],
};
