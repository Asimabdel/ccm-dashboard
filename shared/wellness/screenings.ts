// Prevention & wellness handouts: cancer screenings (drafts; an admin reviews and approves each before patients see it).
import type { WellnessEntry } from "./types";

export const WELLNESS_SCREENINGS: WellnessEntry[] = [
  {
    key: "w_colon_cancer",
    education: {
      en: {
        title: "Colon cancer screening",
        summary:
          "Colon cancer is one of the most common cancers, but screening can stop it before it starts. Tests can find small growths called polyps, so they can be removed before they turn into cancer. Screening also finds cancer early, when it is easiest to treat.",
        whoFor: [
          "Adults ages 45 to 75.",
          "People whose parent, brother, sister, or child had colon cancer or polyps. You may need to start earlier, often by age 40.",
          "Adults 76 to 85: ask us if testing is still right for you.",
        ],
        howOften: "It depends on the test: every year for some home tests, up to every 10 years for a colonoscopy.",
        whatToDo: [
          "Pick the test that works best for you. The best test is the one you actually do.",
          "Home stool test: you collect a small sample of stool (poop) at home and mail it in. Depending on the kit, you repeat it every year or every 3 years.",
          "Colonoscopy: a doctor looks inside your colon with a thin, flexible camera while you get medicine to relax or sleep. If it is normal, you may not need another one for 10 years.",
          "There are other tests too. Ask us which one is best for you.",
          "If someone in your family had colon cancer or polyps, tell us. A colonoscopy is usually the best choice for you.",
          "Most insurance plans cover these screenings. Ask us about yours.",
        ],
        whatToExpect: [
          "Before a colonoscopy, you drink only clear liquids the day before and take a drink that cleans out your bowels. You will need someone to drive you home.",
          "A home test takes just a few minutes. Follow the steps in the kit and mail it back on time.",
          "If a home test is positive (abnormal), you will need a colonoscopy to find out why. Most of the time it is not cancer.",
          "If polyps are found during a colonoscopy, they are usually removed right then. You may need your next test sooner.",
        ],
        talkToUs: [
          "You see blood in your stool, have belly pain that won't go away, or notice changes in your bowel habits. Don't wait for a screening test.",
          "Someone in your family had colon cancer or polyps.",
          "You are not sure which test to choose, or you are worried about the prep.",
        ],
      },
      es: {
        title: "Detección del cáncer de colon",
        summary:
          "El cáncer de colon es uno de los cánceres más comunes, pero las pruebas de detección pueden evitarlo antes de que empiece. Estas pruebas encuentran bultitos llamados pólipos, que se pueden quitar antes de que se conviertan en cáncer. También encuentran el cáncer temprano, cuando es más fácil de tratar.",
        whoFor: [
          "Adultos de 45 a 75 años.",
          "Personas cuyo padre, madre, hermano, hermana o hijo tuvo cáncer de colon o pólipos. Es posible que deba empezar antes, muchas veces a los 40 años.",
          "Adultos de 76 a 85 años: pregúntenos si todavía le conviene hacerse la prueba.",
        ],
        howOften: "Depende de la prueba: cada año para algunas pruebas en casa y hasta cada 10 años para la colonoscopia.",
        whatToDo: [
          "Elija la prueba que mejor le funcione. La mejor prueba es la que usted sí se hace.",
          "Prueba de heces en casa: usted toma una pequeña muestra de heces (popó) en casa y la envía por correo. Según el tipo de prueba, se repite cada año o cada 3 años.",
          "Colonoscopia: un doctor revisa el interior del colon con una cámara delgada y flexible, mientras usted recibe medicina para relajarse o dormir. Si todo sale normal, quizás no necesite otra en 10 años.",
          "Hay otras pruebas también. Pregúntenos cuál es la mejor para usted.",
          "Si alguien en su familia tuvo cáncer de colon o pólipos, díganos. En ese caso, la colonoscopia suele ser la mejor opción.",
          "La mayoría de los seguros médicos cubren estas pruebas de detección. Pregúntenos sobre el suyo.",
        ],
        whatToExpect: [
          "Antes de la colonoscopia, el día anterior solo podrá tomar líquidos claros y tomará una bebida que limpia el intestino. Necesitará a alguien que maneje por usted de regreso a casa.",
          "La prueba en casa toma solo unos minutos. Siga los pasos del kit y envíela a tiempo.",
          "Si la prueba en casa sale positiva (anormal), necesitará una colonoscopia para saber por qué. La mayoría de las veces no es cáncer.",
          "Si encuentran pólipos durante la colonoscopia, normalmente los quitan en ese momento. Tal vez necesite su próxima prueba más pronto.",
        ],
        talkToUs: [
          "Ve sangre en sus heces, tiene dolor de barriga que no se quita o nota cambios en cómo va al baño. No espere a la prueba de detección.",
          "Alguien en su familia tuvo cáncer de colon o pólipos.",
          "No sabe qué prueba elegir o le preocupa la preparación.",
        ],
      },
    },
    basis: [
      "USPSTF 2021 Colorectal Cancer Screening recommendation",
      "American Cancer Society colorectal cancer screening guideline (2018)",
      "US Multi-Society Task Force on Colorectal Cancer screening recommendations (2017, family history)",
    ],
  },
  {
    key: "w_breast_cancer",
    education: {
      en: {
        title: "Breast cancer screening (mammogram)",
        summary:
          "A mammogram is an X-ray picture of the breasts. It can find breast cancer early, often before you or your doctor can feel a lump. Finding it early makes it easier to treat.",
        whoFor: [
          "Women ages 40 to 74.",
          "Women at higher risk, such as those whose mother, sister, or daughter had breast cancer, or who have a gene change passed down in the family. You may need to start earlier or have extra tests.",
          "Women 75 and older: ask us if you should keep having mammograms.",
        ],
        howOften: "Every 2 years for most women ages 40 to 74; ask us if you need it more often.",
        whatToDo: [
          "Schedule your mammogram. Ask us if you need an order first.",
          "If you still have periods, try to go the week after your period, when your breasts are less tender.",
          "On the day of the test, don't use deodorant, powder, or lotion under your arms or on your breasts. They can show up on the X-ray.",
          "Wear a top with pants or a skirt, so you only need to take off your top.",
          "Tell the staff if you have breast implants, are pregnant, or are breastfeeding.",
          "Get to know how your breasts normally look and feel, so you notice any changes.",
          "Most insurance plans cover these screenings. Ask us about yours.",
        ],
        whatToExpect: [
          "Each breast is pressed between two flat plates for a few seconds. This can be uncomfortable, but it is quick. The test takes about 20 minutes.",
          "It is common to be called back for more pictures. Most of the time, it is not cancer.",
          "Your results may say you have 'dense breasts.' This is common and normal, but it can make cancer harder to see. Ask us if you need other tests.",
          "If you don't get your results within 2 weeks, let us know.",
        ],
        talkToUs: [
          "You feel a lump or notice a change in your breast or armpit, even if your last mammogram was normal.",
          "You have fluid coming from a nipple, a nipple that newly turns inward, or skin that dimples or looks like an orange peel.",
          "Your mother, sister, or daughter had breast or ovarian cancer.",
          "You are not sure when to start or how often to go.",
        ],
      },
      es: {
        title: "Detección del cáncer de seno (mamografía)",
        summary:
          "La mamografía es una radiografía de los senos. Puede encontrar el cáncer de seno temprano, muchas veces antes de que usted o su doctor puedan sentir una bolita. Encontrarlo temprano lo hace más fácil de tratar.",
        whoFor: [
          "Mujeres de 40 a 74 años.",
          "Mujeres con más riesgo, por ejemplo si su madre, hermana o hija tuvo cáncer de seno, o si tienen un cambio en un gen que se hereda en la familia. Es posible que deban empezar antes o hacerse otras pruebas.",
          "Mujeres de 75 años o más: pregúntenos si debe seguir haciéndose mamografías.",
        ],
        howOften: "Cada 2 años para la mayoría de las mujeres de 40 a 74 años; pregúntenos si la necesita más seguido.",
        whatToDo: [
          "Haga su cita para la mamografía. Pregúntenos si primero necesita una orden médica.",
          "Si todavía tiene la regla, trate de ir la semana después de su periodo, cuando los senos están menos sensibles.",
          "El día de la prueba, no use desodorante, talco ni crema debajo de los brazos ni en los senos. Pueden aparecer en la radiografía.",
          "Vístase con blusa y pantalón o falda, para que solo tenga que quitarse la blusa.",
          "Avísele al personal si tiene implantes de seno, si está embarazada o si está dando pecho.",
          "Conozca cómo se ven y se sienten normalmente sus senos, para que note cualquier cambio.",
          "La mayoría de los seguros médicos cubren estas pruebas de detección. Pregúntenos sobre el suyo.",
        ],
        whatToExpect: [
          "Cada seno se aprieta entre dos placas planas por unos segundos. Puede ser incómodo, pero es rápido. La prueba toma unos 20 minutos.",
          "Es común que la llamen para tomar más imágenes. La mayoría de las veces no es cáncer.",
          "Sus resultados pueden decir que tiene 'senos densos'. Esto es común y normal, pero puede hacer que el cáncer sea más difícil de ver. Pregúntenos si necesita otras pruebas.",
          "Si no recibe sus resultados en 2 semanas, avísenos.",
        ],
        talkToUs: [
          "Siente una bolita o nota un cambio en el seno o en la axila, aunque su última mamografía haya salido normal.",
          "Le sale líquido del pezón, el pezón se le hunde de repente o la piel del seno se ve hundida o como cáscara de naranja.",
          "Su madre, hermana o hija tuvo cáncer de seno o de ovario.",
          "No está segura de cuándo empezar o cada cuánto hacerse la prueba.",
        ],
      },
    },
    basis: [
      "USPSTF 2024 Breast Cancer Screening recommendation",
      "American Cancer Society breast cancer screening guideline",
    ],
  },
  {
    key: "w_cervical_cancer",
    education: {
      en: {
        title: "Cervical cancer screening (Pap and HPV tests)",
        summary:
          "The cervix is the lower part of the womb (uterus), at the top of the vagina. Screening tests find changes in the cervix early, before they turn into cancer. Most cervical cancer is caused by HPV, a common virus spread through sexual contact.",
        whoFor: [
          "Women ages 21 to 65 who have a cervix.",
          "Women who got the HPV vaccine still need screening.",
          "Women over 65, or who had surgery to remove the womb (hysterectomy): ask us if you still need tests.",
        ],
        howOften: "Every 3 to 5 years, depending on your age and which test you have.",
        whatToDo: [
          "Ages 21 to 29: get a Pap test every 3 years. A Pap test checks cells from the cervix for changes.",
          "Ages 30 to 65: get an HPV test every 5 years, or a Pap test every 3 years, or both together every 5 years.",
          "Some women ages 30 to 65 can collect their own HPV sample with a soft swab, in private. Ask us if this option is right for you.",
          "Try to schedule your test for a time when you don't have your period.",
          "For 2 days before the test, don't have sex, wash inside the vagina (douche), or use tampons or vaginal creams.",
          "Most insurance plans cover these screenings. Ask us about yours.",
        ],
        whatToExpect: [
          "You lie on an exam table. The vagina is gently opened with a tool called a speculum, and a small brush takes cells from the cervix. It takes a few minutes and may feel like pressure.",
          "You may have a little spotting (light bleeding) afterward. This is normal.",
          "An abnormal result usually does not mean cancer. HPV often goes away on its own. You may need a repeat test or a closer look at the cervix with a magnifying tool (colposcopy).",
        ],
        talkToUs: [
          "You have bleeding between periods, after sex, or after menopause.",
          "You have unusual discharge or pain in your lower belly.",
          "You had an abnormal result before, or you have a weak immune system (for example, from HIV or an organ transplant). You may need tests more often.",
        ],
      },
      es: {
        title: "Detección del cáncer de cuello uterino (Papanicolaou y prueba del VPH)",
        summary:
          "El cuello uterino es la parte baja de la matriz (útero), al fondo de la vagina. Las pruebas de detección encuentran cambios temprano, antes de que se conviertan en cáncer. La mayoría de estos cánceres los causa el VPH (virus del papiloma humano), un virus común que se pasa por contacto sexual.",
        whoFor: [
          "Mujeres de 21 a 65 años que tienen cuello uterino.",
          "Las mujeres que recibieron la vacuna contra el VPH también necesitan estas pruebas.",
          "Mujeres mayores de 65 años, o a quienes les quitaron la matriz (histerectomía): pregúntenos si todavía necesitan la prueba.",
        ],
        howOften: "Cada 3 a 5 años, según su edad y el tipo de prueba.",
        whatToDo: [
          "De 21 a 29 años: hágase el Papanicolaou cada 3 años. Esta prueba revisa las células del cuello uterino para ver si hay cambios.",
          "De 30 a 65 años: hágase la prueba del VPH cada 5 años, o el Papanicolaou cada 3 años, o las dos juntas cada 5 años.",
          "Algunas mujeres de 30 a 65 años pueden tomar su propia muestra para la prueba del VPH con un hisopo suave, en privado. Pregúntenos si esta opción es buena para usted.",
          "Trate de hacer su cita para un día en que no tenga la regla.",
          "Durante los 2 días antes de la prueba, no tenga relaciones sexuales, no se haga lavados vaginales y no use tampones ni cremas vaginales.",
          "La mayoría de los seguros médicos cubren estas pruebas de detección. Pregúntenos sobre el suyo.",
        ],
        whatToExpect: [
          "Usted se acuesta en la mesa de examen. Con un instrumento llamado espéculo se abre la vagina con cuidado, y con un cepillito se toman células del cuello uterino. Toma unos minutos y puede sentir presión.",
          "Puede tener un poco de manchado (sangrado leve) después. Esto es normal.",
          "Un resultado anormal por lo general no significa cáncer. El VPH muchas veces se quita solo. Tal vez necesite repetir la prueba o una revisión más de cerca del cuello uterino con un aparato de aumento (colposcopia).",
        ],
        talkToUs: [
          "Tiene sangrado entre periodos, después de tener relaciones sexuales o después de la menopausia.",
          "Tiene flujo vaginal fuera de lo normal o dolor en la parte baja del vientre.",
          "Tuvo un resultado anormal antes, o tiene las defensas bajas (por ejemplo, por VIH o un trasplante de órgano). Es posible que necesite pruebas más seguido.",
        ],
      },
    },
    basis: [
      "USPSTF 2018 Cervical Cancer Screening recommendation (and 2024 draft update)",
      "HRSA Women's Preventive Services Guidelines: cervical cancer screening (incl. self-collected HPV)",
      "American Cancer Society cervical cancer screening guideline",
    ],
  },
  {
    key: "w_lung_cancer",
    education: {
      en: {
        title: "Lung cancer screening",
        summary:
          "Lung cancer screening uses a low-dose CT scan: a detailed X-ray picture of your lungs made with a small amount of radiation. It is for people who smoked a lot and have a higher chance of lung cancer. Finding lung cancer early makes it much easier to treat.",
        whoFor: [
          "Adults ages 50 to 80 with a heavy smoking history who smoke now or quit within the past 15 years.",
          "'Heavy' means at least 20 'pack-years.' For example: 1 pack a day for 20 years, or 2 packs a day for 10 years.",
          "Quit more than 15 years ago? Ask us if screening is still right for you.",
        ],
        howOften: "Once a year, for as long as it is still right for you.",
        whatToDo: [
          "Before your first scan, we will talk with you about the benefits and downsides, so you can decide.",
          "Benefit: the scan can find lung cancer early, when it is easier to treat. This lowers the chance of dying from lung cancer.",
          "Downside: the scan often finds small spots that are not cancer. These can lead to more scans or tests. The scan also uses a small amount of radiation.",
          "If you still smoke, quitting is the best thing you can do for your lungs. Screening does not replace quitting, and we can help you quit.",
          "Most insurance plans cover these screenings. Ask us about yours.",
        ],
        whatToExpect: [
          "You lie on a table that slides through a large, open, ring-shaped scanner. You hold your breath for a few seconds. It takes only a few minutes, with no needles.",
          "Many people have small spots (nodules) on their lungs. Most are not cancer. You may need a follow-up scan to make sure a spot does not change.",
          "We will go over your results with you and plan your next scan.",
        ],
        talkToUs: [
          "You have a cough that won't go away, cough up blood, feel short of breath, or lose weight without trying. These need a visit, not just a screening scan.",
          "You want help to quit smoking or vaping.",
          "You are not sure how many pack-years you have smoked.",
        ],
      },
      es: {
        title: "Detección del cáncer de pulmón",
        summary:
          "Esta prueba usa una tomografía de baja dosis: una radiografía muy detallada de los pulmones que usa poca radiación. Es para personas que han fumado mucho y tienen más riesgo de cáncer de pulmón. Encontrar el cáncer de pulmón temprano lo hace mucho más fácil de tratar.",
        whoFor: [
          "Adultos de 50 a 80 años que han fumado mucho y que todavía fuman o dejaron de fumar en los últimos 15 años.",
          "'Mucho' quiere decir por lo menos 20 'paquetes-año'. Por ejemplo: 1 paquete al día por 20 años, o 2 paquetes al día por 10 años.",
          "¿Dejó de fumar hace más de 15 años? Pregúntenos si esta prueba todavía le conviene.",
        ],
        howOften: "Una vez al año, mientras siga siendo adecuada para usted.",
        whatToDo: [
          "Antes de su primera tomografía, hablaremos con usted sobre los beneficios y las desventajas, para que pueda decidir.",
          "Beneficio: la prueba puede encontrar el cáncer de pulmón temprano, cuando es más fácil de tratar. Esto baja el riesgo de morir de cáncer de pulmón.",
          "Desventaja: la prueba muchas veces encuentra manchitas que no son cáncer. Estas pueden llevar a más tomografías o pruebas. También usa una pequeña cantidad de radiación.",
          "Si todavía fuma, dejar de fumar es lo mejor que puede hacer por sus pulmones. La prueba no reemplaza dejar de fumar, y podemos ayudarle a lograrlo.",
          "La mayoría de los seguros médicos cubren estas pruebas de detección. Pregúntenos sobre el suyo.",
        ],
        whatToExpect: [
          "Usted se acuesta en una mesa que pasa por un aparato grande y abierto, en forma de anillo. Le pedirán que aguante la respiración unos segundos. Toma solo unos minutos y no lleva agujas.",
          "Mucha gente tiene manchitas (nódulos) en los pulmones. La mayoría no son cáncer. Tal vez necesite otra tomografía para asegurarse de que la manchita no cambie.",
          "Revisaremos sus resultados con usted y planearemos su próxima prueba.",
        ],
        talkToUs: [
          "Tiene tos que no se quita, tose sangre, le falta el aire o baja de peso sin tratar. Esto necesita una consulta, no solo la prueba de detección.",
          "Quiere ayuda para dejar de fumar o de vapear.",
          "No sabe bien cuántos paquetes-año ha fumado.",
        ],
      },
    },
    basis: [
      "USPSTF 2021 Lung Cancer Screening recommendation",
      "American Cancer Society 2023 lung cancer screening guideline",
    ],
  },
  {
    key: "w_prostate_cancer",
    education: {
      en: {
        title: "Prostate cancer screening (PSA test)",
        summary:
          "The prostate is a small organ in men, just below the bladder. The PSA test is a simple blood test that can find signs of prostate cancer early. Getting tested is a personal choice, because the test has both benefits and downsides.",
        whoFor: [
          "Men ages 55 to 69: talk with us to decide if testing is right for you.",
          "Men at higher risk may want to talk about it sooner, around age 40 to 45. This includes Black men and men whose father, brother, or son had prostate cancer.",
          "Men 70 and older: routine testing is usually not recommended.",
        ],
        howOften: "If you choose testing, we will decide together how often, usually every 1 to 2 years.",
        whatToDo: [
          "Possible benefit: finding cancer early may lower the chance of dying from prostate cancer.",
          "Possible downside: PSA can be high for other reasons, like an enlarged prostate or an infection. This can lead to worry and more tests, such as a biopsy (taking tiny pieces of the prostate with a needle).",
          "Possible downside: many prostate cancers grow so slowly they would never cause harm. Treating them can cause trouble with erections or leaking urine.",
          "If a slow-growing cancer is found, it can often be watched closely instead of treated right away.",
          "Think about what matters most to you. Talk it over with us and your family.",
          "For 2 days before a PSA test, avoid ejaculation (releasing semen) and long bike rides. They can raise PSA for a short time.",
          "Tell us if you take medicine for an enlarged prostate or hair loss. Some of these can lower PSA.",
        ],
        whatToExpect: [
          "The PSA test is a simple blood draw. You do not need to fast.",
          "A high PSA does not always mean cancer.",
          "If your PSA is high, we may repeat the test or send you to a specialist. An MRI (a detailed scan) may be done before deciding on a biopsy.",
        ],
        talkToUs: [
          "You have trouble urinating (peeing), a weak stream, or need to pee often at night.",
          "You see blood in your urine or semen, or have new pain in your back, hips, or bones.",
          "Your father, brother, or son had prostate cancer, or close family members had breast or ovarian cancer.",
          "You want help deciding if the PSA test is right for you.",
        ],
      },
      es: {
        title: "Detección del cáncer de próstata (prueba de PSA)",
        summary:
          "La próstata es un órgano pequeño que tienen los hombres, justo debajo de la vejiga. La prueba de PSA es un análisis de sangre sencillo que puede encontrar señales tempranas de cáncer de próstata. Hacerse la prueba es una decisión personal, porque tiene beneficios y también desventajas.",
        whoFor: [
          "Hombres de 55 a 69 años: hable con nosotros para decidir si la prueba es buena para usted.",
          "Los hombres con más riesgo quizás quieran hablar de esto antes, alrededor de los 40 a 45 años. Esto incluye a los hombres afroamericanos (de raza negra) y a los hombres cuyo padre, hermano o hijo tuvo cáncer de próstata.",
          "Hombres de 70 años o más: por lo general no se recomienda hacer la prueba de rutina.",
        ],
        howOften: "Si decide hacerse la prueba, decidiremos juntos cada cuánto, por lo general cada 1 o 2 años.",
        whatToDo: [
          "Posible beneficio: encontrar el cáncer temprano puede bajar el riesgo de morir de cáncer de próstata.",
          "Posible desventaja: el PSA puede salir alto por otras razones, como una próstata agrandada o una infección. Esto puede causar preocupación y más pruebas, como una biopsia (sacar pedacitos de la próstata con una aguja).",
          "Posible desventaja: muchos cánceres de próstata crecen tan despacio que nunca causarían daño. El tratamiento puede causar problemas de erección o pérdida de orina.",
          "Si se encuentra un cáncer que crece despacio, muchas veces se puede vigilar de cerca en lugar de tratarlo de inmediato.",
          "Piense en lo que es más importante para usted. Háblelo con nosotros y con su familia.",
          "Durante los 2 días antes de la prueba de PSA, evite eyacular y andar mucho en bicicleta. Esto puede subir el PSA por un tiempo.",
          "Díganos si toma medicina para la próstata agrandada o para la caída del cabello. Algunas pueden bajar el PSA.",
        ],
        whatToExpect: [
          "La prueba de PSA es una simple toma de sangre. No necesita estar en ayunas.",
          "Un PSA alto no siempre significa cáncer.",
          "Si su PSA sale alto, quizás repitamos la prueba o le enviemos con un especialista. A veces se hace una resonancia magnética (un estudio de imágenes detallado) antes de decidir si hace falta una biopsia.",
        ],
        talkToUs: [
          "Tiene dificultad para orinar, el chorro es débil o necesita orinar seguido en la noche.",
          "Ve sangre en la orina o en el semen, o tiene dolor nuevo en la espalda, las caderas o los huesos.",
          "Su padre, hermano o hijo tuvo cáncer de próstata, o algún familiar cercano tuvo cáncer de seno o de ovario.",
          "Quiere ayuda para decidir si la prueba de PSA es buena para usted.",
        ],
      },
    },
    basis: [
      "USPSTF 2018 Prostate Cancer Screening recommendation",
      "American Cancer Society prostate cancer early detection guideline",
    ],
  },
];

/** Points the reviewer should double-check (recently changed guidance, judgment calls). */
export const WELLNESS_SCREENINGS_NOTES: Record<string, string[]> = {
  w_colon_cancer: [
    "Family-history advice (start by about 40, colonoscopy preferred) follows the US Multi-Society Task Force, not USPSTF; confirm the practice agrees.",
    "Ages 76–85 are phrased as 'ask us' (USPSTF: selective screening).",
    "Newer FDA-approved blood tests for colon cancer are not mentioned (not in USPSTF guidance).",
  ],
  w_breast_cancer: [
    "Follows USPSTF 2024 (every 2 years, 40–74); ACS suggests yearly for some ages, so the handout adds 'ask us if you need it more often'. Confirm the practice's preference.",
    "Dense breasts: USPSTF found too little evidence on extra imaging; reports now must state density (FDA, Sept 2024). Handout just says 'ask us'.",
    "Age 75+ and high-risk women (family history, inherited gene change) are phrased as 'ask us'.",
  ],
  w_cervical_cancer: [
    "Self-collected HPV test is included (FDA-approved 2024–2025; in the USPSTF 2024 draft and HRSA guidelines). Confirm our lab offers it; ACS may advise repeating sooner (3 years) after a negative self-collected test.",
    "Start age 21 and the 3-test menu follow USPSTF; ACS now prefers starting at 25 with an HPV test every 5 years.",
    "Stopping after 65 depends on past normal results, so the handout says 'ask us'.",
  ],
  w_lung_cancer: [
    "USPSTF stops screening 15 years after quitting; ACS 2023 dropped that limit. Handout tells people who quit longer ago to 'ask us'.",
    "Medicare covers ages 50–77 and requires a shared decision-making visit before the first scan; the handout mentions the talk but does not promise coverage.",
  ],
  w_prostate_cancer: [
    "Based on USPSTF 2018 (55–69 individual choice; not recommended 70+); a USPSTF update is in progress, so check for newer guidance.",
    "Earlier talks at 40–45 for Black men and men with a family history follow ACS, not USPSTF.",
    "No insurance line on purpose: PSA is not an ACA no-cost preventive service, so coverage and cost-sharing vary.",
  ],
};
