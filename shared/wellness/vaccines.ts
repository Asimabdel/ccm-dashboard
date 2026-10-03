// Prevention & wellness handouts: vaccines (drafts; an admin reviews and approves each before patients see it).
import type { WellnessEntry } from "./types";

export const WELLNESS_VACCINES: WellnessEntry[] = [
  // 1. Flu shot
  {
    key: "w_flu",
    education: {
      en: {
        title: "The flu shot",
        summary:
          "The flu is more than a bad cold. It can lead to pneumonia, hospital stays, and even death, especially in older adults and people with health problems. A flu shot every year is the best way to protect yourself and the people around you.",
        whoFor: [
          "Everyone 6 months and older.",
          "It is extra important if you are 65 or older, pregnant, or have a long-term health problem like diabetes, asthma, or heart disease.",
          "People who live with or care for babies or older adults.",
        ],
        howOften: "Every year, ideally in September or October.",
        whatToDo: [
          "Get your flu shot each fall. If you missed it, getting it later in the season still helps.",
          "If you are 65 or older, ask about a stronger flu shot made for older adults.",
          "You can get your flu shot on the same day as other vaccines.",
          "An egg allergy is not a reason to skip the flu shot. Just tell us about it.",
          "Wash your hands often and stay home when you feel sick, so you don't spread germs.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "The flu shot cannot give you the flu. It takes about 2 weeks to start protecting you.",
          "Your arm may be sore, red, or swollen where you got the shot.",
          "You may feel tired or achy, or have a headache or low fever, for a day or two.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You have ever had a serious reaction to a flu shot.",
          "You had Guillain-Barré syndrome (a rare nerve problem that causes weakness) after a flu shot.",
          "You get flu symptoms like fever, cough, and body aches. Flu medicine works best if you start it within 2 days.",
        ],
      },
      es: {
        title: "La vacuna contra la gripe",
        summary:
          "La gripe (influenza) es más que un resfriado fuerte. Puede causar pulmonía, hospitalización y hasta la muerte, sobre todo en personas mayores y en quienes tienen problemas de salud. Vacunarse cada año es la mejor manera de protegerse usted y proteger a los suyos.",
        whoFor: [
          "Todas las personas de 6 meses en adelante.",
          "Es aún más importante si tiene 65 años o más, está embarazada o tiene un problema de salud crónico, como diabetes, asma o enfermedad del corazón.",
          "Quienes viven con bebés o personas mayores, o los cuidan.",
        ],
        howOften: "Cada año, de preferencia en septiembre u octubre.",
        whatToDo: [
          "Vacúnese cada otoño. Si no lo hizo a tiempo, vacunarse más tarde en la temporada todavía le ayuda.",
          "Si tiene 65 años o más, pregunte por la vacuna más fuerte hecha para personas mayores.",
          "Puede ponerse la vacuna contra la gripe el mismo día que otras vacunas.",
          "Tener alergia al huevo no le impide vacunarse. Solo avísenos.",
          "Lávese las manos seguido y quédese en casa cuando se sienta mal, para no pasar los gérmenes a otros.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "La vacuna no le puede dar gripe. Empieza a protegerle unas 2 semanas después.",
          "Puede tener el brazo adolorido, rojo o hinchado donde le pusieron la vacuna.",
          "Puede sentir cansancio o dolor en el cuerpo, o tener dolor de cabeza o un poco de fiebre, por uno o dos días.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "Alguna vez tuvo una reacción fuerte a la vacuna contra la gripe.",
          "Tuvo el síndrome de Guillain-Barré (un problema raro de los nervios que causa debilidad) después de una vacuna contra la gripe.",
          "Tiene síntomas de gripe, como fiebre, tos y dolor de cuerpo. La medicina para la gripe funciona mejor si la empieza en los primeros 2 días.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC/ACIP Prevention and Control of Seasonal Influenza with Vaccines (annual recommendations)",
      "CDC Vaccine Information Statement: Inactivated Influenza Vaccine",
    ],
  },

  // 2. COVID-19 vaccine
  {
    key: "w_covid",
    education: {
      en: {
        title: "The COVID-19 vaccine",
        summary:
          "COVID-19 is an illness caused by a virus. It can be serious, especially for older adults and people with certain health problems. An updated vaccine lowers your chance of getting very sick or going to the hospital.",
        whoFor: [
          "Adults 65 and older, who have the highest risk of getting very sick.",
          "Adults of any age with health problems like diabetes, heart, lung, or kidney disease, obesity, or a weak immune system.",
          "Other adults can choose to get it after talking with us.",
        ],
        howOften: "An updated vaccine usually comes out each fall; ask us if you should get it.",
        whatToDo: [
          "Ask us if an updated COVID-19 vaccine is right for you this season.",
          "Bring your vaccine record, or tell us when you had your last COVID-19 shot.",
          "You can get it on the same day as your flu shot or other vaccines.",
          "If you had COVID-19 recently, ask us how long to wait before your next shot.",
          "If you have a weak immune system, ask us if you need more than one dose.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "Your arm may be sore, red, or swollen where you got the shot.",
          "You may feel tired or have a headache, muscle aches, chills, or a low fever for a day or two.",
          "Rarely, the vaccine has caused swelling of the heart, mostly in young men. Get care right away for chest pain, shortness of breath, or a pounding heart.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You are not sure if you need an updated vaccine this year.",
          "You had a serious reaction to a COVID-19 vaccine before.",
          "You get COVID-19 and you are 65 or older or have health problems. There are medicines that help if you start them in the first few days.",
        ],
      },
      es: {
        title: "La vacuna contra el COVID-19",
        summary:
          "El COVID-19 es una enfermedad causada por un virus. Puede ser grave, sobre todo en personas mayores y en quienes tienen ciertos problemas de salud. Una vacuna actualizada baja el riesgo de enfermarse gravemente o terminar en el hospital.",
        whoFor: [
          "Adultos de 65 años o más, que tienen el mayor riesgo de enfermarse gravemente.",
          "Adultos de cualquier edad con problemas de salud como diabetes, enfermedad del corazón, los pulmones o los riñones, obesidad o defensas bajas.",
          "Otros adultos pueden decidir vacunarse después de hablarlo con nosotros.",
        ],
        howOften: "Por lo general sale una vacuna actualizada cada otoño; pregúntenos si debe ponérsela.",
        whatToDo: [
          "Pregúntenos si una vacuna actualizada contra el COVID-19 es buena para usted esta temporada.",
          "Traiga su registro de vacunas o díganos cuándo fue su última vacuna contra el COVID-19.",
          "Puede ponérsela el mismo día que la vacuna contra la gripe u otras vacunas.",
          "Si tuvo COVID-19 hace poco, pregúntenos cuánto tiempo debe esperar para vacunarse.",
          "Si tiene las defensas bajas, pregúntenos si necesita más de una dosis.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "Puede tener el brazo adolorido, rojo o hinchado donde le pusieron la vacuna.",
          "Puede sentir cansancio, dolor de cabeza, dolor muscular, escalofríos o un poco de fiebre por uno o dos días.",
          "Muy rara vez la vacuna ha causado inflamación del corazón, sobre todo en hombres jóvenes. Busque atención de inmediato si tiene dolor de pecho, le falta el aire o siente el corazón muy acelerado.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "No sabe si necesita una vacuna actualizada este año.",
          "Tuvo una reacción fuerte a una vacuna contra el COVID-19.",
          "Le da COVID-19 y tiene 65 años o más o problemas de salud. Hay medicinas que ayudan si las empieza en los primeros días.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC Interim Clinical Considerations for Use of COVID-19 Vaccines",
      "FDA approvals of the 2025–2026 COVID-19 vaccines",
    ],
  },

  // 3. Shingles vaccine
  {
    key: "w_shingles",
    education: {
      en: {
        title: "The shingles vaccine",
        summary:
          "Shingles is a painful, blistering rash. It is caused by the same virus as chickenpox, which can wake up many years later. The pain can last for months, and the shingles vaccine works very well to prevent it.",
        whoFor: [
          "Adults 50 and older.",
          "Adults 19 and older with a weak immune system from an illness or a medicine.",
          "Get it even if you had shingles before, had an older type of shingles shot, or don't remember having chickenpox.",
        ],
        howOften: "Two shots, given 2 to 6 months apart.",
        whatToDo: [
          "Get both shots. You need 2 for the best, longest-lasting protection.",
          "Plan your second shot 2 to 6 months after the first. If it has been longer, get it as soon as you can. You don't need to start over.",
          "If you have a weak immune system, we may give the second shot sooner.",
          "If you have shingles right now, wait until the rash is gone.",
          "Feeling unwell after the first shot is common. It is not a reason to skip the second one.",
          "You can get it on the same day as other vaccines.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "Side effects are common and can be strong for a day or two: sore arm, tiredness, muscle aches, headache, chills, fever, or upset stomach.",
          "Plan a quiet day after your shot if you can. Most side effects go away in 2 to 3 days.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You are not sure if you had the shingles vaccine, or if you only got one shot.",
          "You have a weak immune system, or you will soon start a treatment that weakens it. We can help you plan the best time.",
          "You get a painful rash on one side of your body. Shingles medicine works best if you start it within 3 days.",
        ],
      },
      es: {
        title: "La vacuna contra la culebrilla (herpes zóster)",
        summary:
          "La culebrilla (herpes zóster) es un sarpullido doloroso con ampollas. La causa el mismo virus de la varicela, que puede despertar muchos años después. El dolor puede durar meses, y la vacuna funciona muy bien para prevenirla.",
        whoFor: [
          "Adultos de 50 años o más.",
          "Adultos de 19 años o más con las defensas bajas por una enfermedad o un medicamento.",
          "Póngasela aunque ya haya tenido culebrilla, se haya puesto un tipo de vacuna más antiguo o no recuerde haber tenido varicela.",
        ],
        howOften: "Dos dosis, con 2 a 6 meses de diferencia.",
        whatToDo: [
          "Póngase las dos dosis. Necesita las 2 para tener la mejor protección y que le dure más.",
          "Póngase la segunda dosis de 2 a 6 meses después de la primera. Si ya pasó más tiempo, póngasela lo antes posible. No tiene que empezar de nuevo.",
          "Si tiene las defensas bajas, tal vez le pongamos la segunda dosis antes.",
          "Si tiene culebrilla en este momento, espere a que se le quite el sarpullido.",
          "Es común sentirse mal después de la primera dosis. Eso no es razón para no ponerse la segunda.",
          "Puede ponérsela el mismo día que otras vacunas.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "Es común tener molestias fuertes por uno o dos días: brazo adolorido, cansancio, dolor muscular, dolor de cabeza, escalofríos, fiebre o malestar de estómago.",
          "Si puede, planee un día tranquilo después de vacunarse. La mayoría de las molestias se quitan en 2 o 3 días.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "No sabe si se puso esta vacuna, o si solo recibió una dosis.",
          "Tiene las defensas bajas o pronto va a empezar un tratamiento que las baja. Le ayudamos a escoger el mejor momento.",
          "Le sale un sarpullido doloroso en un solo lado del cuerpo. La medicina funciona mejor si la empieza en los primeros 3 días.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC/ACIP Recommendations for Use of Recombinant Zoster Vaccine (2018, 2022 update)",
      "CDC Vaccine Information Statement: Recombinant Shingles Vaccine",
    ],
  },

  // 4. Pneumonia (pneumococcal) vaccine
  {
    key: "w_pneumonia",
    education: {
      en: {
        title: "The pneumonia vaccine",
        summary:
          "Pneumococcal germs can cause pneumonia (a lung infection), blood infections, and meningitis (an infection around the brain). These illnesses can be very serious for older adults and people with long-term health problems. The pneumonia vaccine helps protect you.",
        whoFor: [
          "Adults 50 and older.",
          "Adults 19 to 49 with certain health problems, like diabetes, heart, lung, liver, or kidney disease, or a weak immune system.",
          "Adults 19 to 49 who smoke or have a drinking problem.",
        ],
        howOften: "Most adults need only 1 or 2 shots in their lifetime; we'll check what you need.",
        whatToDo: [
          "Tell us if you've had a pneumonia shot before, and when. This helps us know if you need another one.",
          "Some people need only 1 shot. Others need a second shot later. We'll tell you what is right for you.",
          "Even if you had a pneumonia shot years ago, you may need a newer one now.",
          "You can get it on the same day as your flu shot or other vaccines.",
          "Pneumonia can follow the flu, so get your flu shot every year too.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "The vaccine cannot give you pneumonia.",
          "Your arm may be sore, red, or swollen where you got the shot.",
          "You may feel tired or have a headache, muscle aches, or a low fever for a day or two.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You don't know if you've had a pneumonia shot.",
          "You are under 50 and have a new health problem, like diabetes or heart, lung, or kidney disease.",
          "You have a cough with fever and chills, or you feel short of breath.",
        ],
      },
      es: {
        title: "La vacuna contra la pulmonía (neumococo)",
        summary:
          "La bacteria llamada neumococo puede causar pulmonía (una infección de los pulmones), infecciones de la sangre y meningitis (una infección alrededor del cerebro). Estas enfermedades pueden ser muy graves en personas mayores y en quienes tienen problemas de salud crónicos. La vacuna le ayuda a protegerse.",
        whoFor: [
          "Adultos de 50 años o más.",
          "Adultos de 19 a 49 años con ciertos problemas de salud, como diabetes, enfermedad del corazón, los pulmones, el hígado o los riñones, o defensas bajas.",
          "Adultos de 19 a 49 años que fuman o tienen problemas con el alcohol.",
        ],
        howOften: "La mayoría de los adultos necesita solo 1 o 2 dosis en toda su vida; nosotros revisamos lo que le toca.",
        whatToDo: [
          "Díganos si ya se puso una vacuna contra la pulmonía y cuándo. Así sabremos si necesita otra.",
          "Algunas personas necesitan solo 1 dosis. Otras necesitan una segunda más adelante. Le diremos qué le toca a usted.",
          "Aunque se haya vacunado hace años, tal vez necesite una vacuna más nueva.",
          "Puede ponérsela el mismo día que la vacuna contra la gripe u otras vacunas.",
          "La pulmonía puede venir después de la gripe. Póngase también la vacuna contra la gripe cada año.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "La vacuna no le puede dar pulmonía.",
          "Puede tener el brazo adolorido, rojo o hinchado donde le pusieron la vacuna.",
          "Puede sentir cansancio o tener dolor de cabeza, dolor muscular o un poco de fiebre por uno o dos días.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "No sabe si ya se puso la vacuna contra la pulmonía.",
          "Tiene menos de 50 años y le diagnosticaron un problema de salud nuevo, como diabetes o enfermedad del corazón, los pulmones o los riñones.",
          "Tiene tos con fiebre y escalofríos, o le falta el aire.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC/ACIP Pneumococcal Vaccine Recommendations (age lowered to 50, October 2024)",
      "CDC Vaccine Information Statement: Pneumococcal Conjugate Vaccine",
    ],
  },

  // 5. RSV vaccine (adults)
  {
    key: "w_rsv",
    education: {
      en: {
        title: "The RSV vaccine",
        summary:
          "RSV (respiratory syncytial virus) is a common virus that usually causes cold-like symptoms. In older adults and people with some health problems, it can cause pneumonia and hospital stays. One RSV shot helps protect you for at least 2 seasons.",
        whoFor: [
          "All adults 75 and older.",
          "Adults 50 to 74 who have a higher risk of getting very sick from RSV.",
          "Higher risk includes long-term heart, lung, or kidney disease, diabetes with complications, a weak immune system, severe obesity, or living in a nursing home.",
        ],
        howOften: "One shot only; at this time it is not a yearly vaccine.",
        whatToDo: [
          "Ask us if the RSV vaccine is right for you, especially if you are 50 or older and have a health problem.",
          "The best time to get it is late summer or early fall, before RSV season. But you can get it any time of year.",
          "If you already had an RSV shot, you do not need another one at this time.",
          "You can get it on the same day as other vaccines.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "Your arm may be sore, red, or swollen where you got the shot.",
          "You may feel tired or have a headache or muscle and joint aches for a day or two.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You are 50 or older and not sure if you are at higher risk.",
          "You notice new weakness, tingling, or numbness in your legs or arms in the weeks after the shot. A rare nerve problem (Guillain-Barré syndrome) has been reported.",
          "You are pregnant. There are ways to protect your baby from RSV, and we can talk them over.",
        ],
      },
      es: {
        title: "La vacuna contra el VRS",
        summary:
          "El VRS (virus respiratorio sincitial) es un virus común que casi siempre causa síntomas como de resfriado. En personas mayores y en quienes tienen ciertos problemas de salud, puede causar pulmonía y hospitalización. Una sola vacuna le ayuda a protegerse por lo menos 2 temporadas.",
        whoFor: [
          "Todos los adultos de 75 años o más.",
          "Adultos de 50 a 74 años que tienen mayor riesgo de enfermarse gravemente por el VRS.",
          "Tienen mayor riesgo quienes tienen enfermedad crónica del corazón, los pulmones o los riñones, diabetes con complicaciones, defensas bajas u obesidad severa, o viven en un hogar de ancianos.",
        ],
        howOften: "Una sola dosis; por ahora no es una vacuna de cada año.",
        whatToDo: [
          "Pregúntenos si la vacuna contra el VRS es buena para usted, sobre todo si tiene 50 años o más y algún problema de salud.",
          "Lo mejor es ponérsela a finales del verano o a principios del otoño, antes de la temporada del VRS. Pero se la puede poner en cualquier época del año.",
          "Si ya se puso la vacuna contra el VRS, por ahora no necesita otra.",
          "Puede ponérsela el mismo día que otras vacunas.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "Puede tener el brazo adolorido, rojo o hinchado donde le pusieron la vacuna.",
          "Puede sentir cansancio o tener dolor de cabeza o dolor en los músculos y las articulaciones por uno o dos días.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "Tiene 50 años o más y no sabe si tiene mayor riesgo.",
          "En las semanas después de la vacuna nota debilidad, hormigueo o adormecimiento nuevo en las piernas o los brazos. Muy rara vez se ha reportado un problema de los nervios (síndrome de Guillain-Barré).",
          "Está embarazada. Hay maneras de proteger a su bebé del VRS y podemos hablar de ellas.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC/ACIP RSV Vaccine Recommendations for Adults (2024 and 2025 updates)",
      "FDA safety labeling change for RSV vaccines: Guillain-Barré syndrome (January 2025)",
    ],
  },

  // 6. Tetanus, diphtheria & whooping cough (Tdap/Td)
  {
    key: "w_tdap",
    education: {
      en: {
        title: "Tetanus, diphtheria, and whooping cough shots (Tdap/Td)",
        summary:
          "These shots protect against three serious infections. Tetanus comes from germs in dirt and can get in through a cut, and diphtheria affects the throat. Whooping cough (pertussis) causes long, hard coughing fits and can be deadly for babies.",
        whoFor: [
          "All adults.",
          "Pregnant women, during every pregnancy.",
          "Anyone who spends time with a baby, like parents, grandparents, and caregivers.",
        ],
        howOften: "One Tdap shot if you never had one, then a booster (Tdap or Td) every 10 years.",
        whatToDo: [
          "If you never had a Tdap shot, get one now, no matter when your last tetanus shot was.",
          "After that, get a booster every 10 years.",
          "If you are pregnant, get Tdap during each pregnancy, ideally between weeks 27 and 36. It helps protect your newborn.",
          "Grandparents and caregivers: get up to date at least 2 weeks before you meet a new baby.",
          "If you get a deep or dirty cut, call us. You may need a tetanus shot sooner.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "Your arm may be sore, red, or swollen where you got the shot.",
          "You may have a mild fever, headache, tiredness, or upset stomach for a day or two.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You don't remember when you had your last tetanus shot.",
          "You get a deep or dirty cut, a puncture wound, a burn, or an animal bite.",
          "You had a serious reaction to a tetanus or whooping cough shot before.",
          "You are pregnant, or you will soon be around a newborn.",
        ],
      },
      es: {
        title: "Las vacunas contra el tétanos, la difteria y la tos ferina (Tdap/Td)",
        summary:
          "Estas vacunas protegen contra tres infecciones graves. El tétanos viene de gérmenes en la tierra y puede entrar por una herida, y la difteria afecta la garganta. La tos ferina causa ataques de tos largos y fuertes, y puede ser mortal para los bebés.",
        whoFor: [
          "Todos los adultos.",
          "Las mujeres embarazadas, en cada embarazo.",
          "Quienes pasan tiempo con un bebé, como padres, abuelos y cuidadores.",
        ],
        howOften: "Una dosis de Tdap si nunca se la puso, y después un refuerzo (Tdap o Td) cada 10 años.",
        whatToDo: [
          "Si nunca se ha puesto la Tdap, póngasela ahora, sin importar cuándo fue su última vacuna contra el tétanos.",
          "Después, póngase un refuerzo cada 10 años.",
          "Si está embarazada, póngase la Tdap en cada embarazo, de preferencia entre las semanas 27 y 36. Así protege a su recién nacido.",
          "Abuelos y cuidadores: pónganse al día por lo menos 2 semanas antes de conocer a un bebé recién nacido.",
          "Si se hace una herida profunda o sucia, llámenos. Tal vez necesite la vacuna contra el tétanos antes de tiempo.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "Puede tener el brazo adolorido, rojo o hinchado donde le pusieron la vacuna.",
          "Puede tener un poco de fiebre, dolor de cabeza, cansancio o malestar de estómago por uno o dos días.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "No se acuerda de cuándo fue su última vacuna contra el tétanos.",
          "Tiene una herida profunda o sucia, se clavó algo, se quemó o le mordió un animal.",
          "Tuvo una reacción fuerte a una vacuna contra el tétanos o la tos ferina.",
          "Está embarazada, o pronto va a estar cerca de un bebé recién nacido.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC/ACIP Tdap and Td Vaccine Recommendations (2019 update)",
      "ACOG guidance on Tdap vaccination during pregnancy",
    ],
  },

  // 7. Hepatitis B vaccine
  {
    key: "w_hepatitis_b",
    education: {
      en: {
        title: "The hepatitis B vaccine",
        summary:
          "Hepatitis B is a virus that attacks the liver. It spreads through blood and other body fluids, and many people have it without knowing. Over time it can cause liver damage and liver cancer, and the vaccine protects you.",
        whoFor: [
          "All adults 19 to 59.",
          "Adults 60 and older with a higher chance of getting it, like people on dialysis, people with HIV or hepatitis C, or people whose partner has hepatitis B.",
          "Adults 60 and older without these risks can also choose to get it.",
        ],
        howOften: "A series of 2 or 3 shots over 1 to 6 months, depending on the type of vaccine.",
        whatToDo: [
          "Finish all the shots in your series. Write down the date of your next one.",
          "If you missed a shot, you don't need to start over. Just get the next one.",
          "We may do a blood test to see if you already have hepatitis B or are already protected.",
          "Lower your risk: use condoms, and never share needles, razors, or toothbrushes.",
          "You can get it on the same day as other vaccines.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "The vaccine cannot give you hepatitis B.",
          "Your arm may be sore where you got the shot.",
          "Some people have a mild fever or headache, or feel tired, for a day or two.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You are not sure if you had the hepatitis B vaccine or finished all the shots.",
          "You think you were exposed, for example through sex or a needle. Call us soon; treatment works best when given quickly.",
          "You are pregnant or trying to get pregnant.",
          "Your partner or someone in your home has hepatitis B.",
        ],
      },
      es: {
        title: "La vacuna contra la hepatitis B",
        summary:
          "La hepatitis B es un virus que ataca el hígado. Se pasa por la sangre y otros líquidos del cuerpo, y muchas personas lo tienen sin saberlo. Con el tiempo puede dañar el hígado y causar cáncer de hígado, y la vacuna le protege.",
        whoFor: [
          "Todos los adultos de 19 a 59 años.",
          "Adultos de 60 años o más con mayor riesgo, como quienes están en diálisis, tienen VIH o hepatitis C, o tienen una pareja con hepatitis B.",
          "Los adultos de 60 años o más sin estos riesgos también pueden decidir ponérsela.",
        ],
        howOften: "Una serie de 2 o 3 dosis en un plazo de 1 a 6 meses, según el tipo de vacuna.",
        whatToDo: [
          "Complete todas las dosis de la serie. Anote la fecha de la siguiente.",
          "Si se le pasó una dosis, no tiene que empezar de nuevo. Solo póngase la siguiente.",
          "Tal vez le hagamos un análisis de sangre para ver si ya tiene hepatitis B o si ya tiene protección.",
          "Baje su riesgo: use condón y nunca comparta agujas, rasuradoras ni cepillos de dientes.",
          "Puede ponérsela el mismo día que otras vacunas.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "La vacuna no le puede dar hepatitis B.",
          "Puede tener el brazo adolorido donde le pusieron la vacuna.",
          "Algunas personas tienen un poco de fiebre o dolor de cabeza, o sienten cansancio, por uno o dos días.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "No sabe si se puso la vacuna contra la hepatitis B o si completó todas las dosis.",
          "Cree que pudo haberse contagiado, por ejemplo por sexo o por una aguja. Llámenos pronto; el tratamiento funciona mejor si se da rápido.",
          "Está embarazada o quiere embarazarse.",
          "Su pareja o alguien en su casa tiene hepatitis B.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC/ACIP Universal Hepatitis B Vaccination in Adults Aged 19–59 Years (2022)",
      "CDC Recommendations for Hepatitis B Screening and Testing (2023)",
    ],
  },

  // 8. HPV vaccine (adults)
  {
    key: "w_hpv",
    education: {
      en: {
        title: "The HPV vaccine",
        summary:
          "HPV (human papillomavirus) is a very common virus spread through sexual contact. Most people never know they have it, but some types can cause cancer years later, including cancer of the cervix, throat, anus, and genitals. The HPV vaccine can prevent most of these cancers.",
        whoFor: [
          "Everyone through age 26 who did not get it as a child or did not finish all the shots.",
          "Some adults 27 to 45, after talking it over with us.",
          "It works best at ages 9 to 12, so ask about it for your children and grandchildren too.",
        ],
        howOften: "A short series of shots over several months; we'll tell you how many you need.",
        whatToDo: [
          "If you are 26 or younger and haven't had it, ask us to start today.",
          "If you are 27 to 45, talk with us about whether it is a good choice for you.",
          "Finish all your shots. If you missed one, you don't need to start over.",
          "Women should keep getting cervical cancer screening (Pap or HPV tests), even after the vaccine.",
          "If you are pregnant, wait until after the baby is born to start or finish the shots.",
          "Condoms lower your chance of getting HPV, but they don't remove it completely.",
          "Most insurance plans cover recommended vaccines. Ask us about yours.",
        ],
        whatToExpect: [
          "Your arm may be sore, red, or swollen where you got the shot.",
          "Some people feel dizzy or faint right after a shot. Sitting down for 15 minutes afterward helps.",
          "You may have a headache, upset stomach, or low fever for a day or two.",
          "A severe allergic reaction is rare. Call 911 if you have trouble breathing or swelling of your face or throat.",
        ],
        talkToUs: [
          "You are not sure if you had the HPV vaccine or finished all the shots.",
          "You want to protect your children or grandchildren from cancers caused by HPV.",
          "You notice warts, sores, or lumps in your genital area.",
          "You are due for a Pap or HPV test.",
        ],
      },
      es: {
        title: "La vacuna contra el VPH",
        summary:
          "El VPH (virus del papiloma humano) es un virus muy común que se pasa por contacto sexual. La mayoría de las personas no saben que lo tienen, pero algunos tipos pueden causar cáncer años después, como cáncer del cuello del útero, de la garganta, del ano y de los genitales. La vacuna puede prevenir la mayoría de estos cánceres.",
        whoFor: [
          "Toda persona de hasta 26 años que no la recibió en la niñez o no completó todas las dosis.",
          "Algunos adultos de 27 a 45 años, después de hablarlo con nosotros.",
          "Funciona mejor entre los 9 y los 12 años, así que pregunte también por sus hijos y nietos.",
        ],
        howOften: "Una serie corta de dosis en varios meses; le diremos cuántas necesita.",
        whatToDo: [
          "Si tiene 26 años o menos y no se la ha puesto, pídanos empezar hoy mismo.",
          "Si tiene de 27 a 45 años, hable con nosotros para ver si le conviene.",
          "Complete todas las dosis. Si se le pasó una, no tiene que empezar de nuevo.",
          "Las mujeres deben seguir haciéndose la prueba de cáncer del cuello del útero (Papanicolaou o prueba de VPH), aunque ya estén vacunadas.",
          "Si está embarazada, espere a que nazca el bebé para empezar o terminar las dosis.",
          "Usar condón baja el riesgo de contagiarse de VPH, pero no lo quita por completo.",
          "La mayoría de los seguros médicos cubren las vacunas recomendadas. Pregúntenos por el suyo.",
        ],
        whatToExpect: [
          "Puede tener el brazo adolorido, rojo o hinchado donde le pusieron la vacuna.",
          "Algunas personas se marean o se desmayan justo después de una vacuna. Sentarse por 15 minutos después ayuda.",
          "Puede tener dolor de cabeza, malestar de estómago o un poco de fiebre por uno o dos días.",
          "Una reacción alérgica grave es muy rara. Llame al 911 si le cuesta respirar o se le hincha la cara o la garganta.",
        ],
        talkToUs: [
          "No sabe si se puso la vacuna contra el VPH o si completó todas las dosis.",
          "Quiere proteger a sus hijos o nietos de los cánceres causados por el VPH.",
          "Nota verrugas, llagas o bultos en el área genital.",
          "Ya le toca su prueba de Papanicolaou o de VPH.",
        ],
      },
    },
    basis: [
      "CDC Adult Immunization Schedule",
      "CDC/ACIP Human Papillomavirus Vaccination for Adults (2019 update)",
      "American Cancer Society HPV Vaccine Recommendations",
    ],
  },
];

/** Points the reviewer should double-check (recently changed guidance, judgment calls). */
export const WELLNESS_VACCINES_NOTES: Record<string, string[]> = {
  w_flu: [
    "\"Ask about a stronger flu shot\" at 65+ reflects ACIP's 2022 preference for high-dose, adjuvanted, or recombinant flu vaccine; confirm it still applies this season.",
    "Egg-allergy line follows ACIP (2023 onward: any flu vaccine, no extra precautions). The 2025 ACIP vote for single-dose (thimerosal-free) vaccines doesn't change the handout wording.",
  ],
  w_covid: [
    "Guidance changed in 2025: FDA approved the 2025–26 vaccines for 65+ and for younger people with a high-risk condition, and ACIP/CDC moved to individual (shared) decision-making for everyone. Check the current CDC schedule and any 2026–27 update before approving.",
    "Handout says \"ask us if it's right for you\" instead of recommending it for all adults; some professional groups (e.g., AAFP, ACP, IDSA) recommend it more broadly, and insurance coverage may vary.",
    "Heart-swelling (myocarditis) line reflects FDA's 2025 label update (higher risk in young males); remove it if you prefer.",
  ],
  w_shingles: [
    "Age 19+ with a weakened immune system follows ACIP 2022; for these patients the second dose may be given 1–2 months after the first (handout just says \"sooner\").",
    "Medicare Part D covers ACIP-recommended adult vaccines with no cost-sharing (since 2023), but the handout keeps the generic insurance line.",
  ],
  w_pneumonia: [
    "Age 50+ follows ACIP's October 2024 change (it was 65+).",
    "Which shot(s) depends on product and history (one conjugate shot alone, or conjugate then polysaccharide; catch-up for people who had only older vaccines); the handout leaves this to the clinician, e.g. with CDC's PneumoRecs tool.",
    "The 19–49 risk-condition list is shortened for readability (CDC's list also includes sickle cell/no spleen, HIV, cancer, CSF leak, cochlear implant, and more).",
  ],
  w_rsv: [
    "Ages follow ACIP: all 75+; 60–74 at increased risk (2024); 50–59 at increased risk (voted April 2025, adopted mid-2025). The topic registry currently suggests it only at 75+.",
    "One dose only; no repeat dose was recommended as of 2025. Check whether ACIP has since added one.",
    "Guillain-Barré line reflects FDA's January 2025 warning (within 42 days, for two of the RSV vaccines).",
  ],
  w_tdap: [
    "Wound advice is simplified to \"call us\"; CDC advises a tetanus booster for dirty or major wounds if 5 or more years since the last dose.",
    "Pregnancy timing (weeks 27–36, earlier in that window preferred) per CDC/ACOG; either Tdap or Td may be used for 10-year boosters (ACIP 2019).",
  ],
  w_hepatitis_b: [
    "Universal vaccination for 19–59 follows ACIP 2022. ACIP revisited hepatitis B (the infant birth dose) in December 2025; confirm the adult recommendation is unchanged.",
    "\"2 or 3 shots over 1 to 6 months\" covers the common adult products; dialysis and immunocompromised patients may need a different schedule and a follow-up antibody test.",
    "Not every hepatitis B vaccine is recommended in pregnancy, so pregnant patients are sent to \"talk with us\".",
  ],
  w_hpv: [
    "Number of doses left vague on purpose: 2 if started before age 15, 3 if started at 15+ or immunocompromised; single-dose HPV schedules were under ACIP/HHS review in 2025–2026, so check the current schedule.",
    "Ages 27–45 = shared clinical decision-making (ACIP 2019); the topic registry suggests it only for 19–26.",
    "\"Can prevent most of these cancers\" reflects CDC's \"over 90% of HPV cancers\" figure.",
  ],
};
