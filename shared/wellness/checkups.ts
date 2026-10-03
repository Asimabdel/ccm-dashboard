// Prevention & wellness handouts: check-ups (drafts; an admin reviews and approves each before patients see it).
import type { WellnessEntry } from "./types";

export const WELLNESS_CHECKUPS: WellnessEntry[] = [
  {
    key: "w_wellness_visit",
    education: {
      en: {
        title: "Your yearly wellness visit",
        summary:
          "A wellness visit is a check-up you have when you are not sick. We look at your overall health, update your records, and plan the tests and shots you need. Finding a problem early makes it easier to treat.",
        whoFor: [
          "All adults, even if you feel healthy.",
          "Adults with Medicare. Medicare has its own yearly visit, called the Annual Wellness Visit.",
          "People with long-term health problems, like diabetes or high blood pressure.",
        ],
        howOften: "Once a year.",
        whatToDo: [
          "Bring all your medicines, or a list of them. Include vitamins, herbal remedies, and medicines you buy without a prescription.",
          "Write down your questions and any changes in your health since your last visit.",
          "Bring the names of any other doctors or specialists you see, and any recent test results from other places.",
          "Bring your vaccine records if you have them.",
          "Learn your family's health history, like who has had heart disease, diabetes, or cancer.",
          "Bring your glasses and hearing aids if you use them.",
          "If it helps you, bring a family member or friend with you.",
        ],
        whatToExpect: [
          "We check your weight, blood pressure, and other vital signs, and go over your medicines and health history.",
          "We talk about which screening tests and vaccines are due for you, and we may order blood work.",
          "With Medicare's Annual Wellness Visit, you fill out a health questionnaire. We check your memory, mood, and risk of falling, and make a prevention plan with you. It is a planning visit, not a full head-to-toe exam.",
          "If we look at a new health problem during the same visit, it may be billed separately. Most plans cover a yearly wellness visit. Ask us about yours.",
        ],
        talkToUs: [
          "It has been more than a year since your last check-up.",
          "You are new to Medicare. Ask about the Welcome to Medicare preventive visit in your first 12 months.",
          "You want to plan ahead and choose who will make health decisions for you if you cannot (this is called advance care planning).",
          "You have a health worry and do not want to wait for your yearly visit.",
        ],
      },
      es: {
        title: "Su visita anual de bienestar",
        summary:
          "La visita de bienestar es un chequeo que se hace cuando no está enfermo. Revisamos su salud en general, ponemos al día su expediente y planeamos las pruebas y vacunas que necesita. Encontrar un problema a tiempo hace que sea más fácil de tratar.",
        whoFor: [
          "Todos los adultos, aunque se sientan bien.",
          "Adultos con Medicare. Medicare tiene su propia visita anual, llamada Visita Anual de Bienestar.",
          "Personas con problemas de salud de largo plazo, como diabetes o presión alta.",
        ],
        howOften: "Una vez al año.",
        whatToDo: [
          "Traiga todas sus medicinas o una lista de ellas. Incluya vitaminas, remedios de hierbas y medicinas que compra sin receta.",
          "Apunte sus preguntas y cualquier cambio en su salud desde su última visita.",
          "Traiga los nombres de otros doctores o especialistas que lo atienden, y los resultados recientes de pruebas hechas en otros lugares.",
          "Traiga su cartilla de vacunas si la tiene.",
          "Pregunte en su familia quién ha tenido enfermedades del corazón, diabetes o cáncer.",
          "Traiga sus lentes y sus aparatos para oír si los usa.",
          "Si le ayuda, venga con un familiar o una persona de confianza.",
        ],
        whatToExpect: [
          "Le revisamos el peso, la presión y otros signos vitales, y repasamos sus medicinas y su historial de salud.",
          "Hablamos de qué pruebas de detección y vacunas le tocan, y quizás le pidamos análisis de sangre.",
          "En la Visita Anual de Bienestar de Medicare, usted llena un cuestionario de salud. Revisamos su memoria, su estado de ánimo y su riesgo de caerse, y hacemos con usted un plan de prevención. Es una visita para planear, no un examen completo de pies a cabeza.",
          "Si en la misma visita revisamos un problema de salud nuevo, es posible que se cobre aparte. La mayoría de los planes cubren una visita de bienestar al año. Pregúntenos por el suyo.",
        ],
        talkToUs: [
          "Ha pasado más de un año desde su último chequeo.",
          "Acaba de empezar con Medicare. Pregunte por la visita preventiva Bienvenido a Medicare durante sus primeros 12 meses.",
          "Quiere planear con tiempo y escoger quién tomará decisiones de salud por usted si usted no puede (esto se llama planificación anticipada de la atención).",
          "Tiene una preocupación de salud y no quiere esperar a su visita anual.",
        ],
      },
    },
    basis: [
      "CMS Medicare Learning Network: Medicare Wellness Visits (Annual Wellness Visit and Welcome to Medicare visit)",
      "USPSTF A and B Recommendations for adult preventive care",
    ],
  },
  {
    key: "w_blood_pressure",
    education: {
      en: {
        title: "Checking your blood pressure",
        summary:
          "Blood pressure is how hard your blood pushes on the walls of your blood vessels. High blood pressure usually has no symptoms, but over time it can lead to a heart attack, a stroke, or kidney damage. A quick check is the only way to know your numbers.",
        whoFor: [
          "All adults 18 and older.",
          "People who have high blood pressure or take blood pressure medicine.",
          "People with diabetes, kidney disease, or extra weight, or who have family members with high blood pressure.",
        ],
        howOften: "Every year if you are 40 or older or at higher risk, and every 3 to 5 years if you are 18 to 39 with normal readings.",
        whatToDo: [
          "If we ask you to check at home, use a monitor that goes on your upper arm (not your wrist), with a cuff that fits your arm. Bring it to a visit so we can make sure it reads correctly.",
          "For 30 minutes before you check, do not drink coffee or other caffeine, smoke, or exercise. Use the bathroom first.",
          "Sit quietly for 5 minutes with your back supported, your feet flat on the floor, and your legs uncrossed.",
          "Put the cuff on bare skin on your upper arm, not over clothes. Rest your arm on a table so the cuff is at the level of your heart.",
          "Do not talk during the reading. Take 2 readings, 1 minute apart.",
          "Check in the morning and in the evening, and write down each reading with the date and time. Bring your log to your visits.",
        ],
        whatToExpect: [
          "A cuff on your arm squeezes for a few seconds. It does not hurt. You get two numbers: the top number is the pressure when your heart beats, and the bottom number is the pressure when your heart rests between beats.",
          "In general, below 120/80 is normal. A top number of 120 to 129 is a little high. 130/80 or higher is high blood pressure. Your provider will tell you your goal.",
          "One high reading does not mean you have high blood pressure. We usually confirm it with more readings, often at home.",
          "If your blood pressure is high, healthy changes like eating less salt, moving more, and losing weight help. Some people also need medicine.",
        ],
        talkToUs: [
          "Your home readings are often 130/80 or higher, or above the goal your provider gave you.",
          "Your reading is 180/120 or higher. Rest a few minutes and check again. If it is still that high, call us right away. If you also have chest pain, shortness of breath, numbness or weakness, or trouble seeing or speaking, call 911.",
          "You feel dizzy or like you might faint, especially if you take blood pressure medicine.",
        ],
      },
      es: {
        title: "Chequeos de la presión arterial",
        summary:
          "La presión arterial es la fuerza con la que la sangre empuja las paredes de los vasos sanguíneos. La presión alta casi nunca da síntomas, pero con el tiempo puede causar un ataque al corazón, un derrame cerebral o daño a los riñones. Medirla es la única manera de saber cómo está.",
        whoFor: [
          "Todos los adultos de 18 años o más.",
          "Personas que tienen presión alta o toman medicina para la presión.",
          "Personas con diabetes, enfermedad de los riñones o sobrepeso, o con familiares que tienen presión alta.",
        ],
        howOften: "Cada año si tiene 40 años o más o un riesgo mayor, y cada 3 a 5 años si tiene de 18 a 39 años y su presión sale normal.",
        whatToDo: [
          "Si le pedimos que se tome la presión en casa, use un aparato que se pone en la parte de arriba del brazo (no en la muñeca), con un brazalete del tamaño correcto para su brazo. Tráigalo a una cita para revisar que mida bien.",
          "Durante los 30 minutos antes de medirse, no tome café ni otras bebidas con cafeína, no fume y no haga ejercicio. Vaya al baño primero.",
          "Siéntese en calma 5 minutos, con la espalda apoyada, los pies en el piso y las piernas sin cruzar.",
          "Póngase el brazalete sobre la piel, no sobre la ropa, en la parte de arriba del brazo. Apoye el brazo en una mesa para que el brazalete quede a la altura del corazón.",
          "No hable mientras se mide. Tómese 2 lecturas, con 1 minuto de diferencia.",
          "Mídase en la mañana y en la noche, y anote cada lectura con la fecha y la hora. Traiga sus apuntes a sus citas.",
        ],
        whatToExpect: [
          "El brazalete le aprieta el brazo por unos segundos. No duele. Le salen dos números: el de arriba es la presión cuando el corazón late, y el de abajo es la presión cuando el corazón descansa entre latidos.",
          "Por lo general, menos de 120/80 es normal. Si el número de arriba está entre 120 y 129, está un poco alta. 130/80 o más es presión alta. Su proveedor le dirá cuál es su meta.",
          "Una sola lectura alta no quiere decir que usted tenga presión alta. Por lo general la confirmamos con más lecturas, muchas veces en casa.",
          "Si su presión está alta, ayudan los cambios saludables, como comer menos sal, moverse más y bajar de peso. Algunas personas también necesitan medicina.",
        ],
        talkToUs: [
          "Sus lecturas en casa salen seguido en 130/80 o más, o más altas que la meta que le dio su proveedor.",
          "Su lectura sale en 180/120 o más. Descanse unos minutos y mídase otra vez. Si sigue igual de alta, llámenos de inmediato. Si además tiene dolor de pecho, falta de aire, adormecimiento o debilidad, o problemas para ver o para hablar, llame al 911.",
          "Tiene mareos o siente que se va a desmayar, sobre todo si toma medicina para la presión.",
        ],
      },
    },
    basis: [
      "USPSTF 2021 Hypertension in Adults: Screening",
      "2025 AHA/ACC Guideline for the Prevention, Detection, Evaluation and Management of High Blood Pressure in Adults",
      "AHA patient guidance: monitoring your blood pressure at home",
    ],
  },
  {
    key: "w_cholesterol",
    education: {
      en: {
        title: "Checking your cholesterol",
        summary:
          "Cholesterol is a waxy fat in your blood. Too much of the wrong kind can build up in your blood vessels and lead to a heart attack or stroke. High cholesterol has no symptoms, so a simple blood test is the only way to know.",
        whoFor: [
          "Adults 20 and older, as part of regular check-ups.",
          "Adults 40 to 75, when your provider checks your chance of heart disease.",
          "People with diabetes, high blood pressure, or extra weight, or who smoke.",
          "People whose parent, brother, or sister had heart disease at a young age.",
        ],
        howOften: "Every 4 to 6 years for most healthy adults, and more often if you have risk factors or take cholesterol medicine.",
        whatToDo: [
          "Ask us if you need to fast (not eat) before the test. Most people do not. If you do, have only water, usually for 9 to 12 hours before.",
          "Keep taking your usual medicines on test day, unless we tell you otherwise.",
          "Eat more vegetables, fruits, beans, whole grains, and fish.",
          "Eat less fried food, fatty meat, butter, lard, and sweets.",
          "Move your body at least 150 minutes a week, like a 30-minute walk 5 days a week.",
          "If you smoke, ask us for help quitting.",
          "If you take cholesterol medicine, take it every day as prescribed, even when you feel fine.",
        ],
        whatToExpect: [
          "A small amount of blood is taken from your arm. It takes a few minutes.",
          "The test shows your total cholesterol; LDL, the “bad” cholesterol that clogs blood vessels; HDL, the “good” cholesterol that helps clear it away; and triglycerides, another kind of fat in the blood.",
          "Your provider looks at your results along with your age, blood pressure, diabetes, and smoking to estimate your chance of a heart attack or stroke. Your provider will tell you your goal.",
          "If your risk is high, healthy changes help. Some people also need medicine.",
        ],
        talkToUs: [
          "You have never had your cholesterol checked, or it has been more than 5 years.",
          "A parent, brother, or sister had a heart attack or stroke at a young age (a man before 55 or a woman before 65).",
          "You have muscle aches or other problems you think come from your cholesterol medicine. Do not stop it before talking with us.",
          "You want help with healthy eating or being more active.",
        ],
      },
      es: {
        title: "Chequeos del colesterol",
        summary:
          "El colesterol es una grasa parecida a la cera que está en la sangre. Cuando hay demasiado del tipo malo, se puede acumular en los vasos sanguíneos y causar un ataque al corazón o un derrame cerebral. El colesterol alto no da síntomas, así que la única forma de saberlo es con un análisis de sangre sencillo.",
        whoFor: [
          "Adultos de 20 años o más, como parte de sus chequeos regulares.",
          "Adultos de 40 a 75 años, cuando su proveedor calcula su riesgo de enfermedades del corazón.",
          "Personas con diabetes, presión alta o sobrepeso, o que fuman.",
          "Personas cuyo padre, madre, hermano o hermana tuvo una enfermedad del corazón a temprana edad.",
        ],
        howOften: "Cada 4 a 6 años para la mayoría de los adultos sanos, y más seguido si tiene factores de riesgo o toma medicina para el colesterol.",
        whatToDo: [
          "Pregúntenos si necesita estar en ayunas (sin comer) antes del análisis. La mayoría de las personas no lo necesitan. Si usted sí, tome solo agua, por lo general de 9 a 12 horas antes.",
          "El día del análisis, siga tomando sus medicinas de siempre, a menos que le digamos otra cosa.",
          "Coma más verduras, frutas, frijoles, granos integrales y pescado.",
          "Coma menos comida frita, carnes con mucha grasa, mantequilla, manteca y dulces.",
          "Mueva el cuerpo por lo menos 150 minutos a la semana, por ejemplo, caminar 30 minutos 5 días a la semana.",
          "Si fuma, pídanos ayuda para dejarlo.",
          "Si toma medicina para el colesterol, tómela todos los días como se la recetaron, aunque se sienta bien.",
        ],
        whatToExpect: [
          "Le sacan un poco de sangre del brazo. Tarda unos minutos.",
          "El análisis muestra su colesterol total; el LDL, el colesterol “malo” que tapa los vasos sanguíneos; el HDL, el colesterol “bueno” que ayuda a limpiarlos; y los triglicéridos, otro tipo de grasa en la sangre.",
          "Su proveedor revisa sus resultados junto con su edad, su presión, si tiene diabetes y si fuma, para calcular su riesgo de un ataque al corazón o un derrame cerebral. Su proveedor le dirá cuál es su meta.",
          "Si su riesgo es alto, los cambios saludables ayudan. Algunas personas también necesitan medicina.",
        ],
        talkToUs: [
          "Nunca se ha hecho un análisis de colesterol, o hace más de 5 años del último.",
          "Su padre, madre, hermano o hermana tuvo un ataque al corazón o un derrame cerebral a temprana edad (un hombre antes de los 55 años o una mujer antes de los 65).",
          "Tiene dolores musculares u otras molestias que cree que vienen de su medicina para el colesterol. No la deje antes de hablar con nosotros.",
          "Quiere ayuda para comer más sano o para hacer más actividad física.",
        ],
      },
    },
    basis: [
      "2018 AHA/ACC Guideline on the Management of Blood Cholesterol",
      "USPSTF 2022 Statin Use for the Primary Prevention of Cardiovascular Disease in Adults",
    ],
  },
  {
    key: "w_diabetes_screening",
    education: {
      en: {
        title: "Testing for diabetes and prediabetes",
        summary:
          "Diabetes means you have too much sugar (glucose) in your blood. Prediabetes means your blood sugar is higher than normal, but not high enough to be diabetes. Most people with either one feel fine, so a blood test is the best way to find out early.",
        whoFor: [
          "Adults 35 to 70 who are overweight.",
          "Younger adults who have a parent, brother, or sister with diabetes, had diabetes during pregnancy, or have polycystic ovary syndrome (PCOS), a hormone problem in women.",
          "Hispanic or Latino, Black, Native American, Asian American, and Pacific Islander adults. They have a higher chance of diabetes and may need testing at a younger age or a lower weight.",
        ],
        howOften: "Every 3 years if your results are normal, and every year if you have prediabetes.",
        whatToDo: [
          "Ask us if you need to fast. The A1C test does not need fasting. For a fasting blood sugar test, have nothing to eat or drink but water for at least 8 hours before.",
          "If you have prediabetes, small changes can often bring your blood sugar back to normal.",
          "Losing a little weight helps a lot. If you weigh 200 pounds, losing 10 to 14 pounds (5% to 7%) can lower your chance of getting diabetes by about half.",
          "Move at least 150 minutes a week. A brisk walk counts.",
          "Drink water instead of soda, juice, or sweet tea. Eat more vegetables, beans, and whole grains, and smaller portions of rice, tortillas, and bread.",
          "Ask us about a lifestyle change program for prediabetes. In these programs, a coach and a group help you make these changes.",
        ],
        whatToExpect: [
          "The test is a simple blood draw. The A1C test shows your average blood sugar over the past 2 to 3 months.",
          "A1C: below 5.7% is normal, 5.7% to 6.4% is prediabetes, and 6.5% or higher may mean diabetes. Fasting blood sugar: below 100 is normal, 100 to 125 is prediabetes, and 126 or higher may mean diabetes.",
          "If a result is in the diabetes range, we usually repeat the test to be sure before making a diagnosis.",
          "If you have prediabetes or diabetes, we will make a plan with you. Prediabetes often goes back to normal with healthy changes.",
        ],
        talkToUs: [
          "You are very thirsty, urinate (pee) often, have blurry vision, feel very tired, or are losing weight without trying.",
          "You have cuts or sores that heal slowly, or tingling or numbness in your feet.",
          "You had diabetes during pregnancy. You need a check at least every 3 years for the rest of your life.",
          "You were told you have prediabetes and want help making a plan.",
        ],
      },
      es: {
        title: "Pruebas de diabetes y prediabetes",
        summary:
          "Tener diabetes quiere decir que hay demasiada azúcar (glucosa) en la sangre. La prediabetes quiere decir que el azúcar está más alta de lo normal, pero no tanto como para ser diabetes. La mayoría de las personas con cualquiera de las dos se sienten bien, por eso un análisis de sangre es la mejor forma de saberlo a tiempo.",
        whoFor: [
          "Adultos de 35 a 70 años con sobrepeso.",
          "Adultos más jóvenes que tienen padre, madre, hermano o hermana con diabetes, que tuvieron diabetes durante el embarazo o que tienen síndrome de ovario poliquístico (SOP), un problema hormonal en las mujeres.",
          "Adultos hispanos o latinos, afroamericanos, indígenas americanos, asiático-americanos y de las islas del Pacífico. Tienen más probabilidad de tener diabetes y quizás necesiten la prueba a una edad más joven o con menos peso.",
        ],
        howOften: "Cada 3 años si sus resultados salen normales, y cada año si tiene prediabetes.",
        whatToDo: [
          "Pregúntenos si necesita estar en ayunas. La prueba A1C no lo requiere. Para la prueba de azúcar en ayunas, no coma ni beba nada más que agua por lo menos 8 horas antes.",
          "Si tiene prediabetes, muchas veces unos cambios pequeños pueden regresar su azúcar a lo normal.",
          "Bajar un poco de peso ayuda mucho. Si pesa 200 libras, bajar de 10 a 14 libras (del 5% al 7%) puede reducir más o menos a la mitad su probabilidad de tener diabetes.",
          "Muévase por lo menos 150 minutos a la semana. Caminar a paso rápido cuenta.",
          "Tome agua en vez de refrescos, jugos o té endulzado. Coma más verduras, frijoles y granos integrales, y porciones más pequeñas de arroz, tortillas y pan.",
          "Pregúntenos por un programa de cambio de estilo de vida para la prediabetes. En estos programas, un entrenador y un grupo le ayudan a hacer estos cambios.",
        ],
        whatToExpect: [
          "La prueba es un análisis de sangre sencillo. La prueba A1C muestra el promedio de su azúcar en los últimos 2 a 3 meses.",
          "A1C: menos de 5.7% es normal, de 5.7% a 6.4% es prediabetes, y 6.5% o más puede indicar diabetes. Azúcar en ayunas: menos de 100 es normal, de 100 a 125 es prediabetes, y 126 o más puede indicar diabetes.",
          "Si un resultado sale en el rango de diabetes, por lo general repetimos la prueba para estar seguros antes de dar un diagnóstico.",
          "Si tiene prediabetes o diabetes, haremos un plan juntos. La prediabetes muchas veces vuelve a lo normal con cambios saludables.",
        ],
        talkToUs: [
          "Tiene mucha sed, orina seguido, ve borroso, tiene mucho cansancio o está bajando de peso sin intentarlo.",
          "Tiene cortaduras o llagas que tardan en sanar, u hormigueo o adormecimiento en los pies.",
          "Tuvo diabetes durante el embarazo. Necesita hacerse la prueba por lo menos cada 3 años por el resto de su vida.",
          "Le dijeron que tiene prediabetes y quiere ayuda para hacer un plan.",
        ],
      },
    },
    basis: [
      "USPSTF 2021 Prediabetes and Type 2 Diabetes Screening",
      "ADA Standards of Care in Diabetes: Diagnosis and Classification of Diabetes",
      "CDC National Diabetes Prevention Program",
    ],
  },
  {
    key: "w_bone_density",
    education: {
      en: {
        title: "Bone density test (for osteoporosis)",
        summary:
          "Osteoporosis means your bones have become thin and weak, so they break more easily. It usually has no symptoms until a bone breaks. A bone density test is a quick, painless scan that shows how strong your bones are.",
        whoFor: [
          "Women 65 and older.",
          "Women younger than 65 who have gone through menopause and have a higher risk, such as low body weight, smoking, a parent who broke a hip, or taking steroid medicine for a long time.",
          "Anyone over 50 who broke a bone from a small fall or bump.",
          "Men 70 and older, or men with risk factors, can ask us if the test is right for them.",
        ],
        howOften: "If your result is normal, you may not need another test for several years; your provider will tell you when to repeat it.",
        whatToDo: [
          "On test day, wear comfortable clothes without metal, like zippers, buttons, or belt buckles.",
          "Do not take calcium pills for 24 hours before the test, unless we tell you otherwise.",
          "Tell the staff if you could be pregnant, or if you recently had a test where you swallowed or were given a special dye (contrast or barium).",
          "Get calcium and vitamin D from foods like milk, yogurt, cheese, leafy greens, and foods with added calcium.",
          "Do weight-bearing exercise, like walking or dancing, and exercises that build strength and balance.",
          "Do not smoke, and limit alcohol.",
          "Prevent falls at home: remove loose rugs, use night-lights, and put grab bars in the bathroom.",
        ],
        whatToExpect: [
          "The test is called a DXA scan. You lie on a padded table and stay still while a machine arm passes over your hips and spine. It takes about 10 to 20 minutes and does not hurt.",
          "It uses a very small amount of radiation, less than a regular X-ray.",
          "Your result is called a T-score. A score of -1 or higher is normal. A score between -1 and -2.5 means your bones are thinner than normal (called osteopenia). A score of -2.5 or lower means osteoporosis.",
          "If your bones are thin, your provider will talk with you about ways to protect them and prevent breaks, which may include medicine.",
        ],
        talkToUs: [
          "You broke a bone from a small fall or bump.",
          "You have lost an inch and a half (about 4 cm) or more of height, or your back is becoming more curved.",
          "You take medicines for a long time that can thin bones, such as steroid pills. Do not stop them on your own.",
          "You have fallen, or you are afraid of falling.",
        ],
      },
      es: {
        title: "Prueba de densidad ósea (para la osteoporosis)",
        summary:
          "La osteoporosis quiere decir que los huesos se han vuelto delgados y débiles, y se pueden quebrar más fácilmente. Por lo general no da síntomas hasta que se quiebra un hueso. La prueba de densidad ósea es un estudio rápido y sin dolor que muestra qué tan fuertes están sus huesos.",
        whoFor: [
          "Mujeres de 65 años o más.",
          "Mujeres menores de 65 años que ya pasaron por la menopausia y tienen más riesgo, por ejemplo: peso bajo, fumar, tener un padre o una madre que se fracturó la cadera, o tomar medicina con esteroides por mucho tiempo.",
          "Cualquier persona mayor de 50 años que se fracturó un hueso por una caída o un golpe leve.",
          "Los hombres de 70 años o más, o con factores de riesgo, pueden preguntarnos si la prueba es para ellos.",
        ],
        howOften: "Si su resultado sale normal, quizás no necesite otra prueba por varios años; su proveedor le dirá cuándo repetirla.",
        whatToDo: [
          "El día de la prueba, use ropa cómoda sin metal, como cierres, botones o hebillas.",
          "No tome pastillas de calcio durante las 24 horas antes de la prueba, a menos que le digamos otra cosa.",
          "Avise al personal si podría estar embarazada, o si hace poco le hicieron un estudio en el que tomó o le pusieron un líquido especial (contraste o bario).",
          "Obtenga calcio y vitamina D de alimentos como leche, yogur, queso, verduras de hoja verde y alimentos con calcio añadido.",
          "Haga ejercicio que cargue su propio peso, como caminar o bailar, y ejercicios que le den fuerza y equilibrio.",
          "No fume y limite el alcohol.",
          "Evite caídas en casa: quite los tapetes sueltos, use lucecitas de noche y ponga barras para agarrarse en el baño.",
        ],
        whatToExpect: [
          "La prueba se llama DXA. Usted se acuesta sobre una mesa acolchonada y se queda sin moverse mientras el brazo de una máquina pasa sobre sus caderas y su columna. Tarda de 10 a 20 minutos y no duele.",
          "Usa una cantidad muy pequeña de radiación, menos que una radiografía normal.",
          "Su resultado se llama puntaje T. Un puntaje de -1 o más es normal. Entre -1 y -2.5 quiere decir que sus huesos están más delgados de lo normal (se llama osteopenia). Un puntaje de -2.5 o menos quiere decir osteoporosis.",
          "Si sus huesos están delgados, su proveedor hablará con usted sobre formas de protegerlos y evitar fracturas, lo que puede incluir medicina.",
        ],
        talkToUs: [
          "Se fracturó un hueso por una caída o un golpe leve.",
          "Ha perdido una pulgada y media (unos 4 cm) o más de estatura, o su espalda se está encorvando.",
          "Toma por mucho tiempo medicinas que pueden debilitar los huesos, como pastillas de esteroides. No las deje por su cuenta.",
          "Se ha caído o tiene miedo de caerse.",
        ],
      },
    },
    basis: [
      "USPSTF 2025 Osteoporosis to Prevent Fractures: Screening",
      "Bone Health & Osteoporosis Foundation Clinician's Guide to Prevention and Treatment of Osteoporosis (2022)",
    ],
  },
  {
    key: "w_hepc_hiv",
    education: {
      en: {
        title: "Testing for hepatitis C and HIV",
        summary:
          "Hepatitis C is a virus that harms the liver, and HIV is a virus that weakens the body's defense against infections. Many people with either one feel fine for years without knowing it. Both can be treated very well today, and hepatitis C can usually be cured.",
        whoFor: [
          "All adults 18 to 79 should have a hepatitis C test at least once.",
          "Everyone 15 to 65 should have an HIV test at least once.",
          "Everyone who is pregnant, during each pregnancy.",
          "People at higher risk, at any age: anyone who has shared needles to inject drugs, has a new sex partner or more than one, is a man who has sex with men, has a partner with HIV or hepatitis C, or has had another sexually transmitted infection.",
        ],
        howOften: "At least once as an adult, and once a year or more often if you have ongoing risk.",
        whatToDo: [
          "Ask for the test at your next visit. It is a routine test we offer to all adults. Asking for it does not say anything bad about you.",
          "Both tests use a small blood sample. Some HIV tests use a finger prick or a mouth swab. You do not need to fast.",
          "Your results are private.",
          "Protect yourself: never share needles, syringes, razors, or toothbrushes, and use condoms during sex.",
          "There is a medicine that can prevent HIV for people at higher risk (called PrEP). Ask us if it is right for you.",
          "Ask us about a one-time hepatitis B test too. Experts now recommend it for all adults.",
        ],
        whatToExpect: [
          "Results usually come back in a few days. Rapid HIV tests can give results in less than 30 minutes.",
          "If the hepatitis C test is positive, a second blood test checks whether the virus is still in your body. Some people clear it on their own.",
          "If an HIV test is positive, we do another test to confirm it.",
          "If you have either infection, we will help you start treatment soon. Hepatitis C can usually be cured with pills taken for 8 to 12 weeks. With HIV treatment, people can live long, healthy lives.",
        ],
        talkToUs: [
          "You think you were exposed to HIV in the last 72 hours (3 days). There is medicine that can stop the infection, but it must start fast, so call us or go to urgent care or the emergency room right away.",
          "You are pregnant or planning to become pregnant.",
          "Your skin or the whites of your eyes turn yellow, or your urine (pee) is dark.",
          "You want to know if you should be tested more often.",
        ],
      },
      es: {
        title: "Pruebas de hepatitis C y VIH",
        summary:
          "La hepatitis C es un virus que daña el hígado, y el VIH es un virus que debilita las defensas del cuerpo contra las infecciones. Muchas personas con cualquiera de los dos se sienten bien por años sin saberlo. Hoy en día ambos tienen muy buen tratamiento, y la hepatitis C casi siempre se puede curar.",
        whoFor: [
          "Todos los adultos de 18 a 79 años deben hacerse la prueba de hepatitis C por lo menos una vez.",
          "Todas las personas de 15 a 65 años deben hacerse la prueba de VIH por lo menos una vez.",
          "Toda mujer embarazada, en cada embarazo.",
          "Personas con más riesgo, a cualquier edad: quienes han compartido agujas para inyectarse drogas, tienen una pareja sexual nueva o más de una, hombres que tienen sexo con hombres, quienes tienen una pareja con VIH o hepatitis C, o quienes han tenido otra infección de transmisión sexual.",
        ],
        howOften: "Por lo menos una vez como adulto, y cada año o más seguido si sigue teniendo riesgo.",
        whatToDo: [
          "Pida la prueba en su próxima cita. Es una prueba de rutina que ofrecemos a todos los adultos. Pedirla no dice nada malo de usted.",
          "Las dos pruebas usan una pequeña muestra de sangre. Algunas pruebas de VIH se hacen con un piquete en el dedo o con un hisopo en la boca. No necesita estar en ayunas.",
          "Sus resultados son privados.",
          "Protéjase: nunca comparta agujas, jeringas, rasuradoras ni cepillos de dientes, y use condón en las relaciones sexuales.",
          "Existe una medicina que previene el VIH en personas con más riesgo (se llama PrEP). Pregúntenos si es para usted.",
          "Pregúntenos también por la prueba de hepatitis B, que se hace una sola vez. Los expertos ahora la recomiendan para todos los adultos.",
        ],
        whatToExpect: [
          "Los resultados por lo general llegan en unos días. Las pruebas rápidas de VIH pueden dar el resultado en menos de 30 minutos.",
          "Si la prueba de hepatitis C sale positiva, otro análisis de sangre revisa si el virus sigue en su cuerpo. Algunas personas lo eliminan solas.",
          "Si una prueba de VIH sale positiva, hacemos otra prueba para confirmarlo.",
          "Si tiene cualquiera de las dos infecciones, le ayudaremos a empezar el tratamiento pronto. La hepatitis C casi siempre se cura con pastillas que se toman de 8 a 12 semanas. Con tratamiento para el VIH, las personas pueden tener una vida larga y sana.",
        ],
        talkToUs: [
          "Cree que pudo haber tenido contacto con el VIH en las últimas 72 horas (3 días). Hay una medicina que puede evitar la infección, pero hay que empezarla rápido, así que llámenos o vaya a una clínica de urgencias o a la sala de emergencias de inmediato.",
          "Está embarazada o planea embarazarse.",
          "Su piel o lo blanco de sus ojos se ponen amarillos, o su orina se ve oscura.",
          "Quiere saber si debe hacerse las pruebas más seguido.",
        ],
      },
    },
    basis: [
      "USPSTF 2020 Hepatitis C Virus Infection in Adolescents and Adults: Screening",
      "USPSTF 2019 Human Immunodeficiency Virus (HIV) Infection: Screening",
      "CDC Recommendations for Hepatitis C Screening Among Adults (2020)",
    ],
  },
];

/** Points the reviewer should double-check (recently changed guidance, judgment calls). */
export const WELLNESS_CHECKUPS_NOTES: Record<string, string[]> = {
  w_wellness_visit: [
    "The Medicare Annual Wellness Visit is a planning visit (health questionnaire, memory/mood/fall-risk check, prevention plan), not a head-to-toe physical; the draft says a new problem handled the same day may be billed separately. Confirm this matches how the practice bills.",
    "Commercial plans differ on yearly-physical coverage (every 12 months vs. once per calendar year); the draft avoids promising coverage.",
  ],
  w_blood_pressure: [
    "Categories follow AHA/ACC (normal <120/80, elevated 120–129/<80, high ≥130/80); 'elevated' is simplified to 'a little high'. Goals are left to the provider.",
    "Severe-reading advice (≥180/120: recheck, then call us; call 911 with symptoms) follows AHA patient guidance. Confirm the practice wants patients to call the office for a severe reading without symptoms.",
    "Screening interval (yearly for 40+ or higher risk; every 3–5 years for 18–39 with normal readings) is from USPSTF 2021.",
  ],
  w_cholesterol: [
    "Interval (every 4–6 years from age 20 for low-risk adults) follows the 2018 AHA/ACC guideline. Check whether the practice follows any newer ACC/AHA cholesterol guidance (e.g. the PREVENT risk calculator or a once-in-a-lifetime lipoprotein(a) test) that would change this wording.",
    "LDL and other target numbers are deliberately left out ('your provider will tell you your goal'). The draft also says most people do not need to fast; confirm with the lab the practice uses.",
  ],
  w_diabetes_screening: [
    "USPSTF covers ages 35–70 with overweight/obesity (matches the registry rule); the ADA Standards recommend testing ALL adults 35+ regardless of weight. Decide whether to widen 'who it's for'.",
    "ADA uses a lower BMI cutoff for Asian American adults (23 instead of 25); the draft says 'a lower weight' without numbers.",
    "'Lower your chance by about half' comes from the Diabetes Prevention Program (58% lower risk with ~7% weight loss + 150 min/week). Check whether the practice offers or refers to a CDC-recognized lifestyle program.",
  ],
  w_bone_density: [
    "USPSTF 2025: screen women 65+ and postmenopausal women under 65 at increased risk; evidence is insufficient for men. The 'men 70+' line comes from the Bone Health & Osteoporosis Foundation, not USPSTF; keep or remove.",
    "USPSTF sets no repeat interval, so the draft says 'your provider will tell you' (Medicare generally covers a repeat every 24 months if at risk).",
    "Prep tips (no calcium pills for 24 hours, no metal, tell staff about recent barium/contrast) are standard imaging-center instructions; match them to the center the practice uses.",
  ],
  w_hepc_hiv: [
    "Ages differ by source: HIV USPSTF 15–65 vs. CDC 13–64; hepatitis C USPSTF 18–79 vs. CDC all adults 18+. The draft uses the USPSTF ages.",
    "The one-time hepatitis B test line follows CDC 2023 universal adult hepatitis B screening (outside this topic's USPSTF basis); remove it if the handout should stay to hepatitis C and HIV.",
    "Exposure advice (medicine within 72 hours) tells patients to call us or go to urgent care/ER; confirm the practice can provide or route this same day.",
  ],
};
