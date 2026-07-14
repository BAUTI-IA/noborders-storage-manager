import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ComposableMap, Geographies, Geography, Marker, Line } from "react-simple-maps";
import { BolSection } from "./bol.jsx";
import { MessagesSection } from "./messages.jsx";
import { SuggestionsSection } from "./suggestions.jsx";
import { buildJobCharges, proposeAllocation, serializeAllocLines } from "./paymentAlloc.js";
import { numv, money, jobKey, parseCf, effCf, hasRealCf, STATUSES, statusMeta } from "./analyticsData.js";
import { UsStorageMap, US_GEO_URL, US_NAME_TO_CODE, US_CODE_TO_NAME } from "./usMap.jsx";
import { AnalyticsPage } from "./analytics.jsx";

// Reads from Vercel env vars when present (so the test/preview deployment can
// point to a separate test database), falling back to the production project.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://szkmktxziojzgfjkomua.supabase.co";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_v2VNtyiQ_tTAAmEWDdHwYg_IJ-_IN-5";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Lightweight EN→ES UI toggle ──────────────────────────────────────────────
// The app source is English. When the user picks Spanish, a DOM pass swaps the
// known UI strings in place (text nodes + placeholder/title), reverting on EN.
const I18N_ES = {
  "(choose a unit)": "(elegí una unidad)",
  "(no #)": "(sin #)",
  "(no client)": "(sin cliente)",
  "+ Add": "+ Agregar",
  "+ Add job": "+ Agregar job",
  "+ Add to this unit": "+ Agregar a esta unidad",
  "+ Job to a unit": "+ Job a una unidad",
  "+ Job to unit": "+ Job a unidad",
  "AI metrics and recommendations": "Métricas y recomendaciones con IA",
  "Account": "Cuenta",
  "Actions": "Acciones",
  "Chats": "Chats",
  "Team conversations and direct messages": "Conversaciones del equipo y mensajes directos",
  "Active now": "En línea",
  "Offline": "Desconectado",
  "New chat": "Nuevo chat",
  "Search chats…": "Buscar chats…",
  "Search people…": "Buscar personas…",
  "People": "Personas",
  "Say hi 👋": "Saludá 👋",
  "You: ": "Vos: ",
  "No messages yet": "Todavía no hay mensajes",
  "No messages yet. Say hi! 👋": "Todavía no hay mensajes. ¡Saludá! 👋",
  "No chats yet — tap + to start one.": "Todavía no hay chats — tocá + para empezar uno.",
  "Pick a chat to start messaging": "Elegí un chat para empezar a conversar",
  "Group chat · visible to the whole team": "Chat grupal · visible para todo el equipo",
  "Pick one person for a direct message, or several for a private group.": "Elegí una persona para un mensaje directo, o varias para un grupo privado.",
  "Group name (optional)": "Nombre del grupo (opcional)",
  "Select people": "Elegí personas",
  "Private group": "Grupo privado",
  "Cancel": "Cancelar",
  "To create private groups with selected members, run this SQL once in Supabase (SQL Editor):": "Para crear grupos privados con miembros elegidos, corré este SQL una vez en Supabase (SQL Editor):",
  "I ran it — dismiss": "Ya lo corrí — cerrar",
  "No teammates found.": "No se encontraron compañeros.",
  "Delete message": "Borrar mensaje",
  "Delete group": "Borrar grupo",
  "Seen": "Visto",
  "Seen by": "Visto por",
  "Delivered": "Entregado",
  "Sent": "Enviado",
  "Last seen": "Últ. vez",
  "To enable read receipts and last connection, run this SQL once in Supabase (SQL Editor):": "Para activar los recibos de lectura y la última conexión, corré este SQL una vez en Supabase (SQL Editor):",
  "Send": "Enviar",
  "One-time setup needed": "Se necesita una configuración única",
  "I ran it — retry": "Ya lo corrí — reintentar",
  "Employee feedback and improvement ideas": "Feedback del equipo e ideas de mejora",
  "💡 Share a suggestion": "💡 Compartí una sugerencia",
  "Tell us what's working, what isn't, and what you'd change — ideas here go straight to management.": "Contanos qué funciona, qué no, y qué cambiarías — las ideas llegan directo a la gerencia.",
  "Your idea or feedback… e.g. 'The pickup calendar should show the driver's phone'": "Tu idea o feedback… ej: 'El calendario de pickups debería mostrar el teléfono del driver'",
  "Post without my name": "Publicar sin mi nombre",
  "Send suggestion": "Enviar sugerencia",
  "Sending…": "Enviando…",
  "Write your suggestion first.": "Escribí tu sugerencia primero.",
  "In review": "En revisión",
  "Implemented": "Implementada",
  "Rejected": "Rechazada",
  "Most recent": "Más recientes",
  "Most voted": "Más votadas",
  "No suggestions yet": "Todavía no hay sugerencias",
  "No suggestions in this status": "No hay sugerencias en este estado",
  "Be the first — every idea helps us improve.": "Sé el primero — cada idea nos ayuda a mejorar.",
  "Anonymous": "Anónimo",
  "(you)": "(vos)",
  "Management reply:": "Respuesta de la gerencia:",
  "Reply": "Responder",
  "Edit reply": "Editar respuesta",
  "Save reply": "Guardar respuesta",
  "Reply to the team about this suggestion…": "Respondele al equipo sobre esta sugerencia…",
  "Vote for this": "Votar esta sugerencia",
  "Remove my vote": "Quitar mi voto",
  "Active": "Activo",
  "Active companies": "Empresas activas",
  "Active jobs": "Jobs activos",
  "Add": "Agregar",
  "Add at least one line with an amount.": "Agregá al menos una línea con monto.",
  "Add drivers in the Drivers section to multi-assign": "Cargá drivers en la sección Drivers para multi-asignar",
  "Add extra": "Agregar extra",
  "Add job": "Agregar job",
  "Add to the unit": "Agregar a la unidad",
  "Adding...": "Agregando...",
  "Address": "Direccion",
  "Address or reference visible in the list": "Dirección o referencia visible en la lista",
  "All": "Todos",
  "All documents": "Todos los documentos",
  "All jobs with full detail": "Todos los trabajos con detalle completo",
  "All months": "Todos los meses",
  "Amount": "Monto",
  "Amount ($)": "Monto ($)",
  "Amount ($) *": "Monto ($) *",
  "Amount collected ($)": "Monto cobrado ($)",
  "Analyze with AI": "Analizar con IA",
  "Assign commission": "Asignar comisión",
  "BOL balance to collect": "BOL balance a cobrar",
  "BOL balance to collect from client ($)": "BOL balance a cobrar al cliente ($)",
  "BOL collected": "BOL cobrado",
  "BOL collected ($)": "BOL cobrado ($)",
  "BOL collection pending": "Cobro BOL pendiente",
  "BOL in transit": "BOL en tránsito",
  "Back": "Volver",
  "Bank account": "Cuenta bancaria",
  "Basic info": "Información básica",
  "Broker owes us": "Broker nos debe",
  "Broker-delivery closing sheets": "Closing sheets de broker deliveries",
  "Brokers and outstanding balances": "Brokers y balances pendientes",
  "Brown": "Marrón",
  "CC fees collected": "CC fees cobrados",
  "CF delivered": "CF entregados",
  "CF in transit": "CF en tránsito",
  "Calendar": "Calendario",
  "Cancel": "Cancelar",
  "Cancelled": "Cancelado",
  "Cash": "Cash",
  "Change password": "Cambiar contraseña",
  "Check": "Check",
  "Choose a destination.": "Elegí un destino.",
  "Choose a unit first": "Elegí una unidad primero",
  "Choose or type (CubeSmart...)": "Elegí o escribí (CubeSmart...)",
  "Choose who the document belongs to.": "Elegí a quién pertenece el documento.",
  "City": "Ciudad",
  "Client": "Cliente",
  "Client *": "Cliente *",
  "Client billing": "Billing al cliente",
  "Client email": "Email del cliente",
  "Client name": "Nombre del cliente",
  "Client phone": "Teléfono del cliente",
  "Client storage billing (optional)": "Storage billing al cliente (opcional)",
  "Client storage collection": "Cobro de storage a clientes",
  "Clients": "Clientes",
  "Clients and their jobs": "Clientes y sus trabajos",
  "Close": "Cerrar",
  "Closed": "Cerrado",
  "Closing sheet notes...": "Notas del closing sheet...",
  "Collected": "Cobrado",
  "Collected this month": "Cobrado este mes",
  "Collected via split payment": "Cobrado vía pago dividido",
  "Collection": "Cobro",
  "Collection date": "Fecha de cobro",
  "Collection notes (e.g. split cash + zelle)": "Notas del cobro (ej: split cash + zelle)",
  "Collections, cash in circulation and deposits": "Cobros, efectivo en circulación y depósitos",
  "Commission": "Comisión",
  "Commission assigned": "Comisión asignada",
  "Commission pending": "Comisión pendiente",
  "Companies, documents and expirations": "Empresas, documentos y vencimientos",
  "Company": "Empresa",
  "Completed": "Completado",
  "Concept": "Concepto",
  "Confirm": "Confirmar",
  "Confirm new password": "Confirmar nueva contraseña",
  "Contact": "Contacto",
  "Copy the summary:": "Copiá el resumen:",
  "Create": "Crear",
  "Create account": "Crear cuenta",
  "Create new": "Crear nuevo",
  "Create payment": "Crear pago",
  "Create pickup": "Crear pick up",
  "Create split payments": "Crear pagos divididos",
  "Create trip": "Crear trip",
  "Create your account to sign in": "Crea tu cuenta para acceder",
  "Current password": "Contraseña actual",
  "Current password is incorrect.": "La contraseña actual es incorrecta.",
  "Database": "Base de datos",
  "Database setup": "Configuración de base de datos",
  "Date": "Fecha",
  "Date *": "Fecha *",
  "Days in storage": "Días en storage",
  "Delete": "Eliminar",
  "Delete job": "Eliminar job",
  "Delete split": "Eliminar split",
  "Delete this payment?": "¿Eliminar este pago?",
  "Delete this storage?": "Eliminar este storage?",
  "Delete this timeline event?": "¿Eliminar este evento del timeline?",
  "Delivered": "Entregado",
  "Delivered jobs": "Jobs entregados",
  "Delivered today": "Entregados hoy",
  "Delivery address": "Dirección delivery",
  "Delivery balance ($)": "Balance en delivery ($)",
  "Delivery state": "Delivery estado",
  "Dep. date": "Fecha dep.",
  "Departure": "Salida",
  "Deposit date": "Fecha depósito",
  "Deposited": "Depositado",
  "Deposited this month": "Depositado este mes",
  "Deposited this week": "Depositado esta semana",
  "Description": "Descripción",
  "Discount": "Descuento",
  "Discount reason": "Razón del descuento",
  "Dismiss": "Descartar",
  "Doc type": "Tipo doc",
  "Document type": "Tipo de documento",
  "Drag or tap to upload photo/PDF (jpg, png, heic, pdf)": "Arrastrá o tocá para subir foto/PDF (jpg, png, heic, pdf)",
  "Drag to reorder": "Arrastrá para reordenar",
  "Driver (who dropped it off)": "Driver (quién lo dejó)",
  "Driver + Rep": "Driver + Rep",
  "Driver commission": "Comisión driver",
  "Driver commissions": "Comisiones driver",
  "Driver name": "Nombre del chofer",
  "Driver only": "Solo driver",
  "Due date": "Fecha de vencimiento",
  "Duplicate record deleted": "Registro duplicado eliminado",
  "Duplicate review": "Revisión de duplicados",
  "Duration": "Duración",
  "Edit": "Editar",
  "Edit Extra CF": "Editar Extra CF",
  "Edit broker": "Editar broker",
  "Edit closing sheet": "Editar closing sheet",
  "Edit company": "Editar empresa",
  "Edit document": "Editar documento",
  "Edit driver": "Editar driver",
  "Edit extra": "Editar extra",
  "Edit job": "Editar job",
  "Edit payment": "Editar pago",
  "Edit trip": "Editar trip",
  "Edit truck": "Editar camión",
  "Edit unit": "Editar unidad",
  "Empty": "Vacio",
  "Entity": "Entidad",
  "Entity type": "Tipo de entidad",
  "Error connecting to the AI. Try again.": "Error al conectar con la IA. Intenta de nuevo.",
  "Event type *": "Tipo de evento *",
  "Expected this month": "Esperado este mes",
  "Expired": "Vencido",
  "Expiring in 30 days": "Vencen en 30 días",
  "Expiring soon": "Por vencer",
  "Expiry": "Vencimiento",
  "Extras & Commissions": "Extras & Comisiones",
  "Extras per job and driver/rep commissions": "Extras por job y comisiones de driver/rep",
  "Fill in at least job, client or driver.": "Completá al menos job, cliente o driver.",
  "First month free?": "¿Primer mes gratis?",
  "For the company": "Para la empresa",
  "Generated by": "Generado por",
  "Gross (collected + extras)": "Bruto (cobrado + extras)",
  "Historical ref.": "Ref. histórica",
  "In circulation": "En circulación",
  "In circulation (not deposited)": "En circulación (sin depositar)",
  "In circulation (total)": "En circulación (total)",
  "In storage": "En storage",
  "In transit": "En tránsito",
  "Issue date": "Fecha de emisión",
  "Issued": "Emisión",
  "Issuer": "Emisor",
  "Job type *": "Tipo de job *",
  "Jobs in units": "Jobs en unidades",
  "Jobs with the same number": "Jobs con mismo número",
  "Label / address": "Etiqueta / dirección",
  "Live load per truck": "Carga en vivo por camión",
  "Load": "Cargar",
  "Loading": "Cargando",
  "Loading...": "Cargando...",
  "Location": "Ubicación",
  "Method": "Método",
  "Missing coordinates (search an address or enter lat/lng).": "Faltan las coordenadas (buscá una dirección o cargá lat/lng).",
  "Month": "Mes",
  "Name": "Nombre",
  "Name / number *": "Nombre / número *",
  "Net": "Neto",
  "Net result": "Resultado neto",
  "Net to company": "Neto para la empresa",
  "New": "Nuevo",
  "New broker": "Nuevo broker",
  "New closing sheet": "Nuevo closing sheet",
  "New company": "Nueva empresa",
  "New document": "Nuevo documento",
  "New driver": "Nuevo driver",
  "New job": "Nuevo job",
  "New password": "Nueva contraseña",
  "New payment": "Nuevo pago",
  "New trip": "Nuevo trip",
  "New truck": "Nuevo camión",
  "New unit": "Nueva unidad",
  "No": "No",
  "No FADD": "Sin FADD",
  "No active trip": "Sin viaje activo",
  "No active trips. Create one with “+ Trip”.": "Sin trips activos. Creá uno con “+ Trip”.",
  "No billing records.": "Sin registros de billing.",
  "No brokers added.": "Sin brokers cargados.",
  "No closing sheets. Create one with “+ Closing sheet”.": "Sin closing sheets. Creá uno con “+ Closing sheet”.",
  "No data": "Sin datos",
  "No date": "Sin fecha",
  "No delivered jobs": "Sin jobs entregados",
  "No driver for today": "Sin driver para hoy",
  "No drivers. Add one with “+ Driver”.": "Sin drivers. Agregá uno con “+ Driver”.",
  "No expiry": "Sin vencimiento",
  "No fuel surcharge": "Sin fuel surcharge",
  "No jobs in this status.": "Sin jobs en este estado.",
  "No name": "Sin nombre",
  "No results.": "Sin resultados.",
  "No trip assigned": "Sin trip asignado",
  "No trips.": "Sin trips.",
  "No trucks. Add one with “+ Truck”.": "Sin camiones. Agregá uno con “+ Camión”.",
  "No. / policy / certificate": "N° / póliza / certificado",
  "Notes": "Notas",
  "Occupancy": "Ocupación",
  "Occupied units": "Unidades ocupadas",
  "On another active trip — will move here": "En otro trip activo — se moverá a este",
  "On hold": "En espera",
  "On the gross amount": "Sobre el monto bruto",
  "Open": "Abrir",
  "Open closing sheets": "Closing sheets abiertos",
  "Open date": "Fecha de apertura",
  "Operation drivers": "Choferes de la operación",
  "Operation settings": "Configuración de la operación",
  "Other fees description": "Descripción other fees",
  "Out for delivery": "En entrega",
  "Outstanding BOL collections": "Cobros BOL pendientes",
  "Outstanding balance": "Balance pendiente",
  "Owes us": "Nos debe",
  "Pads missing (auto)": "Pads faltantes (auto)",
  "Pads outstanding ($)": "Pads pendientes ($)",
  "Pads received from broker": "Pads recibidos del broker",
  "Pads returned (post-delivery)": "Pads devueltos (post-delivery)",
  "Password must be at least 8 characters.": "La contraseña debe tener al menos 8 caracteres.",
  "Password updated.": "Contraseña actualizada.",
  "Passwords do not match.": "Las contraseñas no coinciden.",
  "Payment date": "Fecha de pago",
  "Payment due date": "Vencimiento de pago",
  "Payment method": "Método de pago",
  "Payment stage": "Etapa del pago",
  "Pending": "Pendiente",
  "Pending collection": "Pendiente de cobro",
  "Period": "Período",
  "Phone": "Teléfono",
  "Photo": "Foto",
  "Photo / file": "Foto / archivo",
  "Physical units and occupancy": "Unidades físicas y ocupación",
  "Pick up + Delivery (same day)": "Pick up + Delivery (mismo día)",
  "Picked up": "Levantado",
  "Pickup & delivery dispatch": "Despacho de pickups y deliveries",
  "Pickup address": "Dirección pickup",
  "Pickup balance ($)": "Balance en pickup ($)",
  "Pickup state": "Pickup estado",
  "Projection if everything is deposited": "Proyección si se deposita todo",
  "Reason": "Motivo",
  "Received": "Recibido",
  "Received by": "Recibido por",
  "Received date": "Fecha recibido",
  "Received this month": "Recibido este mes",
  "Received this week": "Recibido esta semana",
  "Record collection (BOL)": "Registrar cobro (BOL)",
  "Remitter (who bought it)": "Remitter (quién compró)",
  "Remove line": "Quitar línea",
  "Rep commissions": "Comisiones rep",
  "Rep only": "Solo rep",
  "Replace file": "Reemplazar archivo",
  "Review possible duplicates": "Revisar posibles duplicados",
  "Run the SQL to enable billing.": "Corré el SQL para activar billing.",
  "Run the SQL to enable settlements.": "Corré el SQL para activar settlements.",
  "Run the setup SQL to enable brokers.": "Corré el SQL de configuración para activar brokers.",
  "Run the setup SQL to enable drivers.": "Corré el SQL de configuración para activar drivers.",
  "Run the setup SQL to enable trucks.": "Corré el SQL de configuración para activar camiones.",
  "Sat": "Sáb",
  "Save": "Guardar",
  "Save changes": "Guardar cambios",
  "Save collection": "Guardar cobro",
  "Save commission": "Guardar comisión",
  "Save event": "Guardar evento",
  "Save extra": "Guardar extra",
  "Save job": "Guardar job",
  "Save location": "Guardar ubicación",
  "Saving...": "Guardando...",
  "Scheduled": "Programados",
  "Scheduled pickups": "Pick ups programados",
  "Search": "Buscar",
  "Search by address / city": "Buscar por dirección / ciudad",
  "Search by job # or client…": "Buscar por job # o cliente…",
  "Search by job #, client, driver, company, unit...": "Buscar por job #, cliente, driver, empresa, unidad...",
  "Search by job #, client, driver, pickup, delivery...": "Buscar por job #, cliente, driver, pickup, delivery...",
  "Search by job #, client, driver, zip, location...": "Buscar por job #, cliente, driver, zip, ubicación...",
  "Search company, location, zip, unit...": "Buscar empresa, ubicación, zip, unidad...",
  "Search for a job to add it.": "Buscá un job para agregarlo.",
  "Search job # / client / storage to add...": "Buscar job # / cliente / storage para agregar...",
  "Search job # or client to add...": "Buscar job # o cliente para agregar...",
  "Search job # or client…": "Buscar job # o cliente…",
  "Select": "Seleccionar",
  "Select a job to record the extras and their commissions.": "Seleccioná un job para poder registrar los extras y sus comisiones.",
  "Sign in": "Iniciar sesión",
  "Sign in to continue": "Iniciá sesión para continuar",
  "Sign out": "Salir",
  "Skip": "Saltar",
  "Status": "Estado",
  "Sticker color": "Color del sticker",
  "Sticker unassigned": "Sticker sin asignar",
  "That job is already in that unit": "Ese job ya está en esa unidad",
  "That job is already in this unit.": "Ese job ya está en esta unidad.",
  "To collect": "A cobrar",
  "Today": "Hoy",
  "Total amount ($) *": "Monto total ($) *",
  "Total collected": "Total cobrado",
  "Total outstanding": "Total pendiente",
  "Total to collect": "Total a cobrar",
  "Truck": "Camión",
  "Truck fleet": "Flota de camiones",
  "Type": "Tipo",
  "Type an address to search.": "Escribí una dirección para buscar.",
  "US states": "Estados USA",
  "Unit": "Unidad",
  "Unit #": "Unidad #",
  "Unit capacity": "Capacidad de la unidad",
  "Unit status": "Estado de la unidad",
  "Units": "Unidades",
  "Up to date": "Al día",
  "Update password": "Actualizar contraseña",
  "User": "Usuario",
  "View": "Ver",
  "We owe": "Le debemos",
  "We owe brokers": "Le debemos a brokers",
  "Wed": "Mié",
  "Week": "Semana",
  "What happened": "Qué pasó",
  "Where it's stored": "Dónde está guardado",
  "Who has it": "Quién tiene",
  "Who has the money?": "¿Quién tiene el dinero?",
  "With fuel surcharge": "Con fuel surcharge",
  "Without fuel surcharge": "Sin fuel surcharge",
  "Yes": "Sí",
  "client@email.com": "cliente@email.com",
  "just now": "recién",
  "legal@company.com": "legal@empresa.com",
  "no broker": "sin broker",
  "no client": "sin cliente",
  "no month": "ningún mes",
  "no truck": "sin camión",
  "not updated": "sin actualizar",
  "records": "registros",
  "unit": "unidad",
  "units": "unidades",
  "· 1st month free": "· 1er mes gratis",
  "— Unassigned —": "— Sin asignar —",
  "+ New job": "+ Nuevo job",
  "+ Payment": "+ Pago",
  "+ Truck": "+ Camión",
  "+ New broker": "+ Nuevo broker",
  "+ Company": "+ Empresa",
  "+ Document": "+ Documento",
  "+ Closing sheet": "+ Closing sheet",
  "+ Trip": "+ Trip",
  "+ Add payment": "+ Agregar pago",
  "+ Add event": "+ Agregar evento",
  "+ Add extra": "+ Agregar extra",
  "Reps / Employees": "Reps / Empleados",
  "Mark all delivered": "Mark all delivered",
  "Send manifest to driver": "Enviar manifest al driver",
  "Request deposit": "Pedir depósito",
  "Crear pago": "Crear pago",
  "Create payment": "Crear pago",
  "Create split payments": "Crear pagos divididos",
  "New payment": "Nuevo pago",
  "Edit payment": "Editar pago",
  "Save collection": "Guardar cobro",
  "Mark as in transit": "Salir (en tránsito)",
  "Depart (in transit)": "Salir (en tránsito)",
  "Complete trip…": "Completar trip…",
  "Cancel trip": "Cancelar trip",
  "Mark completed": "Marcar completado",
  "Mark as In Transit": "Marcar en tránsito",
  "Mark as Loading": "Marcar cargando",
  "Mark as Completed": "Marcar completado",
  "Reopen (mark as In Transit)": "Reabrir (marcar en tránsito)",
  "Reopen (mark as Loading)": "Reabrir (marcar cargando)",
  "Cancel Trip": "Cancelar trip",
  "New trips start as Loading": "Los trips nuevos empiezan en Cargando",
  "✨ Suggest trips (AI)": "✨ Sugerir trips (IA)",
  "AI trip suggestions": "Sugerencias de trips (IA)",
  "Why this trip:": "Por qué este trip:",
  "no longer available": "ya no disponible",
  "Review & create": "Revisar y crear",
  "Review & add": "Revisar y agregar",
  "New suggestions": "Nuevas sugerencias",
  "AI recommendations": "Recomendaciones con IA",
  "Automatic analysis of your storage operation": "Análisis automático de tu operación de storage",
  "Analyze with AI": "Analizar con IA",
  "Analyzing...": "Analizando...",
  "Manage": "Gestionar",
  "Add job to trip": "Agregar job al trip",
  "Unplanned pickup": "Pickup no previsto",
  "No jobs available.": "Sin jobs disponibles.",
  "No jobs on this trip.": "Sin jobs en este trip.",
  "Today": "Hoy",
  "➕ Add existing job": "➕ Agregar job existente",
  "Add existing job to calendar": "Agregar job existente al calendario",
  "Pickup Calendar": "Calendario de Pickups",
  "Delivery Calendar": "Calendario de Entregas",
  "Scheduled deliveries": "Entregas programadas",
  "Add existing job to delivery calendar": "Agregar job existente al calendario de entregas",
  "Delivery date": "Fecha de delivery",
  "Only jobs without a delivery date are listed. Pick a date above, then click a job to put it on the calendar.": "Solo se listan jobs sin fecha de delivery. Elegí una fecha arriba y hacé clic en un job para ponerlo en el calendario.",
  "No matching jobs without a delivery date.": "No hay jobs sin fecha de delivery que coincidan.",
  "No jobs pending a delivery date.": "No hay jobs pendientes de fecha de delivery.",
  "Add to calendar": "Agregar al calendario",
  "Edit pickup date": "Editar fecha de pickup",
  "Remove from calendar": "Quitar del calendario",
  "Pickup date from": "Fecha de pickup desde",
  "Pickup date to (optional)": "Fecha de pickup hasta (opcional)",
  "Pickup date": "Fecha de pickup",
  "Pickup date saved": "Fecha de pickup guardada",
  "Removed from calendar": "Quitado del calendario",
  "🆕 Create new job on this day": "🆕 Crear job nuevo en este día",
  "📋 Add an existing job to this day": "📋 Agregar un job existente a este día",
  "Search": "Buscar",
  "Add event": "Agregar evento",
  "Save event": "Guardar evento",
  "Delete job": "Eliminar job",
  "Total": "Total",
  "Expected": "Esperado",
  "Collected (job)": "Cobrado (job)",
  "Storage Billing": "Storage Billing",
  "Add billing": "Activar billing",
  "+ Add billing": "+ Activar billing",
  "Mark as paid": "Marcar pagado",
  "Send reminder": "Enviar recordatorio",
  "Edit rate": "Editar tarifa",
  "Activate billing for a job": "Activar billing para un job",
  "No active storage billing clients": "Sin clientes de storage billing activos",
  "Active storage clients": "Clientes de storage activos",
  "Outstanding this month": "Pendiente este mes",
  "Due this week": "Vence esta semana",
  "Collected this month": "Cobrado este mes",
  "Overdue": "Vencido",
  "Activate storage billing": "Activar storage billing",
  "Edit storage billing": "Editar storage billing",
  "Monthly rate ($)": "Tarifa mensual ($)",
  "Billing start date": "Fecha de inicio de billing",
  "First month free": "Primer mes gratis",
  "1st month free": "1er mes gratis",
  "Optional notes": "Notas opcionales",
  "Activate billing": "Activar billing",
  "Billing start:": "Inicio de billing:",
  "Current period:": "Período actual:",
  "Amount due this period:": "Monto de este período:",
  "Search by job # or client name…": "Buscar por job # o cliente…",
  "Billing records for each 30-day period are generated automatically.": "Los registros de cada período de 30 días se generan automáticamente."
};
const i18nCache = new WeakMap();   // text node -> original English value
function i18nApply() {
  const dict = I18N_ES;
  if (!document.body) return;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const nodes = []; let n;
  while ((n = tw.nextNode())) nodes.push(n);
  for (const t of nodes) {
    const pn = t.parentNode; if (!pn) continue;
    const tag = pn.nodeName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") continue;
    // Never rewrite text inside SVG (charts/maps): Recharts re-renders on every
    // hover and the swap would fight React's reconciliation.
    if (pn.ownerSVGElement || tag === "svg" || tag === "text" || tag === "tspan") continue;
    const raw = t.nodeValue; const key = raw.trim();
    if (!key) continue;
    const tr = dict[key];
    if (tr && tr !== key) {
      if (!i18nCache.has(t)) i18nCache.set(t, raw);
      const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
      t.nodeValue = lead + tr + trail;
    }
  }
  document.querySelectorAll("[placeholder],[title]").forEach(el => {
    for (const attr of ["placeholder", "title"]) {
      if (!el.hasAttribute(attr)) continue;
      const v = el.getAttribute(attr), key = (v || "").trim(), tr = dict[key];
      if (tr && tr !== key) {
        const ck = "__i18n_" + attr;
        if (!el[ck]) el[ck] = v;
        el.setAttribute(attr, tr);
      }
    }
  });
}
function i18nRestore() {
  if (!document.body) return;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const nodes = []; let n;
  while ((n = tw.nextNode())) nodes.push(n);
  for (const t of nodes) { if (i18nCache.has(t)) { t.nodeValue = i18nCache.get(t); i18nCache.delete(t); } }
  document.querySelectorAll("[placeholder],[title]").forEach(el => {
    for (const attr of ["placeholder", "title"]) {
      const ck = "__i18n_" + attr;
      if (el[ck]) { el.setAttribute(attr, el[ck]); el[ck] = null; }
    }
  });
}

// One physical storage = one row in `storages`. Jobs that pass through a unit are
// tracked as history in `storage_jobs`. Multiple jobs can be active at once.
const STORAGE_JOBS_SQL = `create table if not exists public.storage_jobs (
  id bigint generated always as identity primary key,
  storage_id bigint references public.storages(id) on delete cascade,
  job_number text,
  customer text,
  driver text,
  date_in date,
  date_out date,
  notes text,
  created_at timestamptz default now()
);
alter table public.storage_jobs enable row level security;
create policy "storage_jobs_auth_all" on public.storage_jobs
  for all to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.storage_jobs;`;

const today = () => new Date().toISOString().slice(0, 10);

// A storage = a physical unit (fixed: company, location, unit, gate code, account).
// Jobs (customer, job number, driver, dates, notes) live in storage_jobs as history.
const EMPTY_FORM = {
  brand:"", state:"", zip:"", address:"", unit:"", size:"",
  gate_code:"", lock:"", email:"", account:"", phone:"", situation:"Open",
  monthly_cost:"", card_on_file:"", date_opened:"", payment_due_date:"", driver_id:""
};

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
const STANDARD_SIZES = ["5x5","5x10","5x15","10x10","10x15","10x20","10x25","10x30","12x20","15x20","20x20"];

// A job can span several locations: one storage_jobs row per location (rented
// unit via storage_id, or company warehouse via `warehouse`), sharing job_number.
const WAREHOUSES = ["Indiana", "New Jersey"];
const EMPTY_BROKER = { name:"", contact_name:"", contact_phone:"", contact_email:"", notes:"" };
const EMPTY_DRIVER = { name:"", phone:"", whatsapp_group_link:"", truck_id:"", notes:"", active:true };
const EMPTY_TRUCK = { name:"", plate:"", capacity_cf:"", notes:"", active:true, year:"", make:"", model:"", vin:"", license_plate:"", license_state:"" };
// "2019 Freightliner Cascadia" subtitle from a truck row.
const truckSubtitle = (t) => [t.year, t.make, t.model].filter(Boolean).join(" ");
const EMPTY_TRIP = { trip_number:"", truck_id:"", driver_id:"", departure_date:"", status:"loading", notes:"", job_keys:[], purposes:{} };
const TRIP_STATUS = {
  loading:    { l:"Loading", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" },
  in_transit: { l:"In transit", bg:"#EDE9FE", text:"#6D28D9", dot:"#7C3AED" },
  completed:  { l:"Completed", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  cancelled:  { l:"Cancelled", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
};
function TripBadge({ status }) {
  const c = TRIP_STATUS[status] || TRIP_STATUS.loading;
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />{c.l}</span>;
}
const TRIP_ACTIVE = (s) => s === "loading" || s === "in_transit";

// ── Extras & Commissions ──
const EXTRA_TYPES = [
  { v:"extra_cf", l:"Extra CF" },
  { v:"shuttle", l:"Shuttle" },
  { v:"long_carry", l:"Long carry" },
  { v:"stairs", l:"Stairs" },
  { v:"packing", l:"Packing" },
  { v:"flight_charge", l:"Flight charge" },
  { v:"other", l:"Other" },
];
const extraTypeLabel = (v) => EXTRA_TYPES.find(t => t.v === v)?.l || v;
// Colored pill per extra type (for the commissions page chips).
const EXTRA_TYPE_COLORS = {
  extra_cf:     { bg:"#E6F1FB", fg:"#185FA5" },
  shuttle:      { bg:"#EDE9FE", fg:"#6D28D9" },
  long_carry:   { bg:"#FDE3CF", fg:"#C2410C" },
  stairs:       { bg:"#FCE7F3", fg:"#BE185D" },
  packing:      { bg:"#EAF3DE", fg:"#3B6D11" },
  flight_charge:{ bg:"#FEF3C7", fg:"#92760B" },
  other:        { bg:"#F1F1F1", fg:"#666" },
};
function ExtraTypeChip({ type, amount }) {
  const c = EXTRA_TYPE_COLORS[type] || EXTRA_TYPE_COLORS.other;
  return <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:20, background:c.bg, color:c.fg, whiteSpace:"nowrap" }}>{extraTypeLabel(type)}{amount != null ? ` $${Math.round(amount).toLocaleString()}` : ""}</span>;
}
const GEN_BY = [
  { v:"driver_only", l:"Driver only" },
  { v:"driver_and_rep", l:"Driver + Rep" },
  { v:"rep_only", l:"Rep only" },
];
const genByLabel = (v) => GEN_BY.find(g => g.v === v)?.l || v;
// Long carry / stairs are always driver-only (driver 50% / company 50%).
const EXTRA_LOCKED_DRIVER = (t) => t === "long_carry" || t === "stairs";
// Commission % auto-fill rules. Returns { driver, rep } percentages; always editable after.
function commissionDefaults(extraType, generatedBy) {
  if (extraType === "long_carry" || extraType === "stairs") return { driver:50, rep:0 };
  if (extraType === "shuttle") {
    if (generatedBy === "driver_only") return { driver:10, rep:0 };
    if (generatedBy === "driver_and_rep") return { driver:7, rep:3 };
    if (generatedBy === "rep_only") return { driver:0, rep:5 };
  }
  // extra_cf, packing, flight_charge, other
  if (generatedBy === "driver_only") return { driver:10, rep:0 };
  if (generatedBy === "driver_and_rep") return { driver:7, rep:3 };
  if (generatedBy === "rep_only") return { driver:0, rep:10 };
  return { driver:0, rep:0 };
}
// Extra CF math: CF×rate subtotal, fuel surcharge, total, and the commission base.
function extraCfCalc(o) {
  const cfCount = numv(o.extra_cf_count), cfRate = numv(o.extra_cf_rate);
  const cfSub = cfCount * cfRate;
  const fuelPct = numv(o.fuel_surcharge_pct);
  const fuelAmt = cfSub * fuelPct / 100;
  const total = cfSub + fuelAmt;
  const commissionBase = o.commission_base === "without_fuel" ? "without_fuel" : "with_fuel";
  const base = commissionBase === "without_fuel" ? cfSub : total;
  return { cfCount, cfRate, cfSub, fuelPct, fuelAmt, total, commissionBase, base };
}
const EMPTY_EMPLOYEE = { name:"", role:"", phone:"", email:"", active:true };

// One row of the per-job extras matrix. A row is "active" when an extra exists for
// this (job, type, driver). Editing amount/% persists on blur; selects persist on change.
function ExtraRow({ type, extra, driverId, drivers, employees, onActivate, onPatch, onToggle, onDelete, onEdit }) {
  const active = !!extra && extra.active !== false;
  const locked = EXTRA_LOCKED_DRIVER(type);
  const isCf = type === "extra_cf";
  const [amount, setAmount] = useState(extra?.amount ?? "");
  const [dPct, setDPct] = useState(extra?.driver_commission_pct ?? "");
  const [rPct, setRPct] = useState(extra?.rep_commission_pct ?? "");
  const [desc, setDesc] = useState(extra?.description ?? "");
  useEffect(() => {
    setAmount(extra?.amount ?? ""); setDPct(extra?.driver_commission_pct ?? "");
    setRPct(extra?.rep_commission_pct ?? ""); setDesc(extra?.description ?? "");
  }, [extra?.id, extra?.amount, extra?.driver_commission_pct, extra?.rep_commission_pct, extra?.description]);
  const gen = extra?.generated_by || "driver_only";
  const cell = { padding:"5px 6px", fontSize:12, verticalAlign:"middle" };
  const miniInp = { fontSize:12, padding:"4px 6px", borderRadius:6, border:"1px solid #e5e5e5", width:62, outline:"none" };
  // Extra CF commissions apply to the chosen base; everything else to the amount.
  const commBase = isCf ? (numv(extra?.commission_base_amount) || numv(amount)) : numv(amount);
  const dc = commBase * numv(dPct) / 100;
  const rc = commBase * numv(rPct) / 100;
  return (
    <tr style={{ borderBottom:"1px solid #f6f6f6", background: active ? "#fff" : "#fcfcfc" }}>
      <td style={{ ...cell, textAlign:"center" }}>
        <input type="checkbox" checked={active}
          onChange={e => { if (e.target.checked) { extra ? onToggle(extra, true) : onActivate(type); } else if (extra) onToggle(extra, false); }} />
      </td>
      <td style={{ ...cell, fontWeight:600, whiteSpace:"nowrap" }}>
        {extraTypeLabel(type)}
        {extra?.source === "payment_split" && <span title="Collected via split payment" style={{ fontSize:9, fontWeight:700, color:"#6D28D9", background:"#EDE9FE", borderRadius:20, padding:"1px 6px", marginLeft:5 }}>pago</span>}
        {type === "other" && active && <input value={desc} onChange={e => setDesc(e.target.value)} onBlur={() => onPatch(extra, { description: desc })} placeholder="Detalle" style={{ ...miniInp, width:120, marginLeft:6 }} />}
      </td>
      <td style={{ ...cell, minWidth: active && isCf ? 190 : undefined }}>{!active ? <span style={{ color:"#ccc" }}>—</span> : isCf ? (
        <div style={{ display:"flex", alignItems:"flex-start", gap:6 }}>
          <div style={{ lineHeight:1.45, fontSize:10.5 }}>
            <div><b>{numv(extra.extra_cf_count).toLocaleString()} CF</b> × {money(extra.extra_cf_rate) || "$0"} = {money(extra.extra_cf_subtotal) || "$0"}</div>
            <div style={{ color:"#888" }}>fuel {numv(extra.fuel_surcharge_pct)}% +{money(extra.fuel_surcharge_amount) || "$0"}</div>
            <div>Total c/fuel: <b>{money(extra.extra_total_with_fuel) || "$0"}</b></div>
            <div style={{ color:"#854F0B" }}>Base com.: <b>{money(extra.commission_base_amount) || "$0"}</b> ({extra.commission_base === "without_fuel" ? "s/fuel" : "c/fuel"})</div>
          </div>
          <button onClick={() => onEdit(extra)} title="Edit Extra CF" style={{ border:"none", background:"none", cursor:"pointer", color:"#185FA5", fontSize:13 }}>✎</button>
        </div>
      ) : <input value={amount} onChange={e => setAmount(e.target.value)} onBlur={() => onPatch(extra, { amount })} placeholder="$" style={{ ...miniInp, width:78 }} />}</td>
      <td style={cell}>{active ? (
        <select value={extra?.driver_id || ""} onChange={e => onPatch(extra, { driver_id: e.target.value || null })} style={{ ...miniInp, width:112, borderColor: extra?.driver_id ? "#e5e5e5" : "#fca5a5" }}>
          <option value="">— Select —</option>
          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      ) : <span style={{ color:"#ccc" }}>—</span>}</td>
      <td style={cell}>{active ? (
        <select value={gen} disabled={locked} onChange={e => onPatch(extra, { generated_by: e.target.value })} style={{ ...miniInp, width:108, opacity: locked ? 0.6 : 1 }}>
          {GEN_BY.map(g => <option key={g.v} value={g.v}>{g.l}</option>)}
        </select>
      ) : <span style={{ color:"#ccc" }}>—</span>}</td>
      <td style={cell}>{active && gen !== "driver_only" ? (
        <select value={extra?.rep_id || ""} onChange={e => onPatch(extra, { rep_id: e.target.value || null })} style={{ ...miniInp, width:112 }}>
          <option value="">— Select —</option>
          {employees.map(em => <option key={em.id} value={em.id}>{em.name}</option>)}
        </select>
      ) : <span style={{ color:"#ccc" }}>—</span>}</td>
      <td style={cell}>{active ? <input value={dPct} onChange={e => setDPct(e.target.value)} onBlur={() => onPatch(extra, { driver_commission_pct: dPct })} style={miniInp} /> : null}</td>
      <td style={cell}>{active ? <input value={rPct} onChange={e => setRPct(e.target.value)} onBlur={() => onPatch(extra, { rep_commission_pct: rPct })} style={miniInp} /> : null}</td>
      <td style={{ ...cell, color:"#1A8A4E", fontWeight:700, whiteSpace:"nowrap" }}>{active ? (money(dc) || "$0") : ""}</td>
      <td style={{ ...cell, color:"#185FA5", fontWeight:700, whiteSpace:"nowrap" }}>{active ? (money(rc) || "$0") : ""}</td>
      <td style={{ ...cell, textAlign:"center" }}>{active && extra ? <button onClick={() => onDelete(extra)} title="Delete" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:15, lineHeight:1 }}>×</button> : null}</td>
    </tr>
  );
}
const EMPTY_CS = { closing_sheet_number:"", broker_id:"", driver_id:"", load_date:"", status:"open", charge_per_pad:"7", trip_cost:"", labor_charges:"", other_fees:"", other_fees_description:"", notes:"", document_url:"", job_keys:[] };
const CS_STATUS = {
  open:     { l:"Open", bg:"#E6F1FB", text:"#185FA5", dot:"#378ADD" },
  settled:  { l:"Settled", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  disputed: { l:"Disputed", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
};
function CSBadge({ status }) {
  const c = CS_STATUS[status] || CS_STATUS.open;
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />{c.l}</span>;
}
const PAY_METHODS = [
  { v:"cash", l:"Cash" },
  { v:"credit_card", l:"Credit card" },
  { v:"zelle", l:"Zelle" },
  { v:"venmo", l:"Venmo" },
  { v:"check", l:"Check" },
  { v:"money_order", l:"Money order" },
  { v:"paypal", l:"PayPal" },
  { v:"cashapp", l:"Cash App" },
  { v:"wire_transfer", l:"Wire transfer" },
  { v:"apple_pay", l:"Apple Pay" },
];
const payMethodLabel = (v) => v ? (PAY_METHODS.find(p => p.v === v)?.l || v) : "";
// Reusable payment-method <select>: always blank-default, optional, saves null when blank.
function PaymentMethodSelect({ value, onChange, style }) {
  return (
    <select style={style} value={value || ""} onChange={e => onChange(e.target.value || null)}>
      <option value="">— Select payment method —</option>
      {PAY_METHODS.map(pm => <option key={pm.v} value={pm.v}>{pm.l}</option>)}
    </select>
  );
}
// Collection status for a BOL job: complete / partial / pending.
function collectionStatus(j) {
  const bal = numv(j.bol_balance), col = numv(j.bol_collected);
  if (bal > 0 && col >= bal) return { key:"complete", l:"Collected", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" };
  if (col > 0) return { key:"partial", l:"Parcial", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" };
  return { key:"pending", l:"Pending", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" };
}
// Missing pads for a single job (received minus returned, floored at 0).
const jobPadsMissing = (j) => Math.max(0, numv(j.pads_received) - numv(j.pads_returned));
// All settlement math for a closing sheet given its (deduped-by-job) job rows.
// Pads are now tallied per job (received/returned), not from the sheet header.
function sheetCalc(sheet, jobsIn) {
  let carrierFee = 0, bolBalance = 0, bolCollected = 0, totalCf = 0, padsSent = 0, padsReturned = 0, padsMissing = 0;
  for (const j of jobsIn) {
    const cf = parseCf(j.volume);
    totalCf += cf;
    carrierFee += cf * numv(j.carrier_rate_per_cf);
    bolBalance += numv(j.bol_balance);
    bolCollected += numv(j.bol_collected);
    padsSent += numv(j.pads_received);
    padsReturned += numv(j.pads_returned);
    padsMissing += jobPadsMissing(j);
  }
  const padsCharge = padsMissing * (sheet?.charge_per_pad != null ? numv(sheet.charge_per_pad) : 7);
  const deductions = numv(sheet?.trip_cost) + numv(sheet?.labor_charges) + numv(sheet?.other_fees) + padsCharge;
  const netCarrier = carrierFee - deductions;       // what the broker owes us
  const pending = Math.max(0, bolBalance - bolCollected);
  const net = netCarrier - bolCollected;            // >0 broker owes us, <0 we owe broker
  return { carrierFee, bolBalance, bolCollected, totalCf, padsSent, padsReturned, padsMissing, padsCharge, deductions, netCarrier, pending, net, jobCount: jobsIn.length };
}
// ── Payments module: money in, who holds it, what's banked ──
const EMPTY_PAY_ACCOUNT = { name:"", bank_name:"", account_type:"", account_last4:"", notes:"", active:true };
const PAY_CONCEPTS = [
  { v:"job", l:"Job", bg:"#E6F1FB", text:"#185FA5" },
  { v:"extra", l:"Extra", bg:"#EDE9FE", text:"#6D28D9" },
  { v:"cc_fee", l:"CC Fee", bg:"#FAEEDA", text:"#854F0B" },   // amber
  { v:"storage", l:"Storage", bg:"#EAF3DE", text:"#3B6D11" },
  { v:"on_account", l:"A cuenta", bg:"#FEF3C7", text:"#92760B" }, // received but not yet applied to a charge
  { v:"other", l:"Other", bg:"#F1F1F1", text:"#666" },
];
// Detailed check / money order options.
const CHECK_TYPES = [
  { v:"cashiers_check", l:"Cashier's check" },
  { v:"personal_check", l:"Personal check" },
  { v:"official_check", l:"Official check" },
];
const checkTypeLabel = (v) => CHECK_TYPES.find(c => c.v === v)?.l || v || "";
const MO_TYPES = [
  { v:"usps", l:"USPS" },
  { v:"western_union", l:"Western Union" },
  { v:"moneygram", l:"MoneyGram" },
  { v:"other", l:"Other" },
];
const moTypeLabel = (v) => MO_TYPES.find(m => m.v === v)?.l || v || "";
const CHECK_BANKS = ["Chase/JPMorgan", "Bank of America", "Wells Fargo", "Fifth Third Bank", "Citibank", "TD Bank", "US Bank", "PNC", "Truist", "Other"];
// Reference number, issuer and attached photo for a payment (check/MO aware).
const payRef = (p) => p.check_serial || p.mo_serial || p.method_id || "";
const payIssuer = (p) => p.method === "check" ? (p.check_bank || "") : p.method === "money_order" ? moTypeLabel(p.mo_type) : "";
const payPhotoUrl = (p) => p.check_photo_url || p.mo_photo_url || "";
const payConceptLabel = (v) => PAY_CONCEPTS.find(c => c.v === v)?.l || v;
// Split-payment line concepts. Each maps to a payment concept and, for extra
// types, the job_extras extra_type used to auto-link commission tracking.
const SPLIT_CONCEPTS = [
  { v:"job",           l:"Job",           pay:"job",    extra:null },
  { v:"extra_cf",      l:"Extra CF",      pay:"extra",  extra:"extra_cf" },
  { v:"shuttle",       l:"Shuttle",       pay:"extra",  extra:"shuttle" },
  { v:"long_carry",    l:"Long carry",    pay:"extra",  extra:"long_carry" },
  { v:"stairs",        l:"Stairs",        pay:"extra",  extra:"stairs" },
  { v:"packing",       l:"Packing",       pay:"extra",  extra:"packing" },
  { v:"flight_charge", l:"Flight charge", pay:"extra",  extra:"flight_charge" },
  { v:"cc_fee",        l:"CC Fee",        pay:"cc_fee", extra:null },
  { v:"other",         l:"Other",         pay:"other",  extra:null },
];
const splitConcept = (v) => SPLIT_CONCEPTS.find(c => c.v === v) || SPLIT_CONCEPTS[0];
function ConceptBadge({ concept }) {
  const c = PAY_CONCEPTS.find(x => x.v === concept) || PAY_CONCEPTS[4];
  return <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 8px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>{c.l}</span>;
}
// Distinct color per payment method for quick scanning.
const PAY_METHOD_META = { cash:"#1A8A4E", check:"#185FA5", money_order:"#0E7490", zelle:"#7C3AED", venmo:"#3D95CE", credit_card:"#EA7C27", paypal:"#172C70", cashapp:"#00B844", wire_transfer:"#92400E", apple_pay:"#111111" };
function PaymentMethodBadge({ method }) {
  if (!method) return <span style={{ color:"#bbb" }}>—</span>;
  const hex = PAY_METHOD_META[method] || "#666";
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:10.5, fontWeight:600, padding:"2px 8px", borderRadius:20, background:hex+"1a", color:hex, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:hex }} />{payMethodLabel(method)}</span>;
}
// Drag-and-drop / click photo box for a check or money-order document (jpg/png/heic/pdf).
function PayPhotoBox({ url, onFile, uploading, label }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  const isPdf = (url || "").toLowerCase().includes(".pdf");
  return (
    <div style={{ marginTop:8 }}>
      <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>{label || "Photo / file"}</div>
      <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
        onClick={() => ref.current?.click()}
        style={{ border:`2px dashed ${drag ? "#378ADD" : "#ddd"}`, borderRadius:10, padding: url ? "8px" : "14px", textAlign:"center", background: drag ? "#E6F1FB" : "#fafafa", cursor:"pointer", fontSize:12, color:"#888" }}>
        {uploading ? "Subiendo…" : url ? (
          <div style={{ display:"flex", alignItems:"center", gap:10, justifyContent:"center" }}>
            {isPdf ? <span style={{ fontSize:28 }}>📄</span> : <img src={url} alt="" style={{ maxHeight:56, maxWidth:90, borderRadius:6, objectFit:"cover" }} />}
            <span style={{ color:"#185FA5" }}>Replace file</span>
          </div>
        ) : "Drag or tap to upload photo/PDF (jpg, png, heic, pdf)"}
      </div>
      <input ref={ref} type="file" accept="image/*,.heic,application/pdf" style={{ display:"none" }} onChange={e => { const f = e.target.files[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}
// Cash, check and money order are physically held; everything else is digital.
const PHYSICAL_METHODS = ["cash", "check", "money_order"];
const isPhysical = (m) => PHYSICAL_METHODS.includes(m);
const isDigitalMethod = (m) => !!m && !PHYSICAL_METHODS.includes(m);
const paymentNet = (p) => numv(p.amount) - numv(p.discount);
// Whether a payment counts as banked/deposited. Digital methods are auto-banked
// (legacy rows may still have banked = null), so they always count as banked;
// physical cash/checks count only when explicitly marked banked = true. A null
// banked on a physical payment is therefore treated as "in circulation".
const effectiveBanked = (p) => isDigitalMethod(p.method) ? true : p.banked === true;
// Deposit date used for the "Deposited this month" window. Falls back to the
// received/payment date for digital rows that were auto-banked without a date.
const bankedDateOf = (p) => p.banked_date || (isDigitalMethod(p.method) ? (p.received_date || p.payment_date || "") : "");
const daysSince = (dateStr) => { if (!dateStr) return 0; const d = new Date(dateStr + "T00:00:00"); return Math.floor((Date.now() - d.getTime()) / 86400000); };
const EMPTY_PAYMENT = {
  job_id:"", payment_date:"", amount:"", concept:"job", method:"cash", method_id:"", check_type:"",
  discount:"", discount_reason:"", received:false, received_date:"", received_by:"", cash_with_whom:"",
  banked:false, banked_date:"", bank_account:"", payment_stage:"", notes:"",
  // check
  check_serial:"", check_transaction_number:"", check_remitter:"", check_purchased_by:"", check_bank:"",
  check_from:"", check_routing:"", check_account_last4:"", check_date:"", check_memo:"", check_photo_url:"",
  // money order
  mo_type:"usps", mo_serial:"", mo_date:"", mo_post_office:"", mo_from_name:"", mo_from_address:"",
  mo_payment_for:"", mo_issuer_location:"", mo_photo_url:"",
  // credit-card fee
  cc_fee_enabled:true, cc_fee_pct:"3", cc_fee_amount:"", cc_fee_payment_id:null,
  // split payment (form-only; never sent verbatim)
  split_enabled:false, split_lines:[{ concept:"job", amount:"", notes:"" }],
};

// ── Legal & Compliance module ──
const EMPTY_COMPANY = { name:"", dot_number:"", mc_number:"", ein:"", state:"", address:"", phone:"", email:"", active:true, notes:"" };
const EMPTY_COMP_DOC = { entity_type:"company", entity_id:"", document_type:"insurance", document_name:"", document_number:"", issuer:"", issue_date:"", expiry_date:"", document_url:"", notes:"" };
// All known compliance document types (text column, so the set is open-ended).
const DOC_TYPE_LABELS = {
  insurance:"Insurance", dot:"DOT Registration", mc_authority:"MC Authority", ifta:"IFTA",
  irp:"IRP / Apportioned", w9:"W-9", cdl:"CDL", medical_card:"Medical card", mvr:"MVR",
  contract:"Contract", registration:"Registration", annual_inspection:"Annual inspection",
  ifta_decal:"IFTA decal", drug_test:"Drug test", background_check:"Background check", other:"Other",
};
const docTypeLabel = (v) => DOC_TYPE_LABELS[v] || v || "—";
// Document grid per entity type (the cells shown on each card).
const DOC_GRID = {
  company: ["insurance", "dot", "mc_authority", "ifta", "irp", "w9", "other"],
  truck:   ["registration", "insurance", "irp", "annual_inspection", "ifta_decal", "other"],
  driver:  ["cdl", "medical_card", "mvr", "drug_test", "background_check", "other"],
};
const ENTITY_LABELS = { company: "Company", truck: "Truck", driver: "Driver" };
// Auto status from expiry date: expired / expiring_soon (≤30d) / active / none.
function docStatus(doc) {
  if (!doc || !doc.expiry_date) return "none";
  const td = today();
  if (doc.expiry_date < td) return "expired";
  if (doc.expiry_date <= addDaysStr(td, 30)) return "expiring_soon";
  return "active";
}
const docDaysToExpiry = (doc) => doc?.expiry_date ? Math.round((new Date(doc.expiry_date + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000) : null;
const DOC_STATUS_META = {
  active:        { l:"Up to date", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  expiring_soon: { l:"Expiring soon", bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" },
  expired:       { l:"Expired", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
  none:          { l:"No date", bg:"#f1f1f1", text:"#888", dot:"#bbb" },
};
function ComplianceBadge({ status }) {
  const c = DOC_STATUS_META[status] || DOC_STATUS_META.none;
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:10.5, fontWeight:700, padding:"2px 8px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot }} />{c.l}</span>;
}
// One cell in an entity's compliance document grid. Drag & drop or click to upload.
function DocCell({ label, doc, onAdd, onEdit, onFile }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef();
  const st = doc ? docStatus(doc) : "none";
  const days = doc ? docDaysToExpiry(doc) : null;
  const expColor = st === "expired" ? "#A32D2D" : st === "expiring_soon" ? "#854F0B" : "#888";
  return (
    <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      style={{ border:`1px ${drag ? "dashed #378ADD" : "solid #eee"}`, borderRadius:9, padding:"9px 10px", background: drag ? "#E6F1FB" : "#fff", minHeight:90, display:"flex", flexDirection:"column", gap:4 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <span style={{ fontSize:11, fontWeight:700 }}>{label}</span>
        <span style={{ marginLeft:"auto" }}><ComplianceBadge status={st} /></span>
      </div>
      {doc ? (
        <>
          <div style={{ fontSize:11, color:"#555", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{doc.document_number ? `#${doc.document_number}` : (doc.document_name || "—")}{doc.issuer ? ` · ${doc.issuer}` : ""}</div>
          <div style={{ fontSize:10.5, color: expColor }}>{doc.expiry_date ? `Vence ${doc.expiry_date}${days != null ? ` (${days < 0 ? `hace ${-days}d` : `${days}d`})` : ""}` : "No expiry"}</div>
          <div style={{ display:"flex", gap:9, marginTop:"auto", alignItems:"center" }}>
            {doc.document_url
              ? <a href={doc.document_url} target="_blank" rel="noreferrer" style={{ fontSize:10.5, color:"#185FA5", textDecoration:"none" }}>📎 Ver</a>
              : <span style={{ fontSize:10.5, color:"#bbb" }}>No file</span>}
            <button onClick={() => inputRef.current?.click()} style={{ fontSize:10.5, color:"#185FA5", border:"none", background:"none", cursor:"pointer", padding:0 }}>Subir</button>
            <button onClick={onEdit} style={{ fontSize:10.5, color:"#888", border:"none", background:"none", cursor:"pointer", padding:0 }}>Edit</button>
          </div>
        </>
      ) : (
        <button onClick={onAdd} style={{ marginTop:"auto", fontSize:11, color:"#185FA5", border:"1px dashed #cfe0f0", background:"#F7FBFF", borderRadius:7, padding:"7px", cursor:"pointer" }}>+ Add / upload</button>
      )}
      <input ref={inputRef} type="file" accept="image/*,application/pdf" style={{ display:"none" }} onChange={e => { const f = e.target.files[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}

const EMPTY_JOB = { storage_ids:[], warehouses:[], driver_ids:[], job_number:"", customer:"", driver:"", date_in:"", fadd:"", volume:"", real_cf:"", lot_number:"", sticker_color:"", job_type:"full", status:"scheduled", calendar_status:"active", broker_id:"", rep:"", client_phone:"", client_email:"", pickup_balance:"", delivery_balance:"", price_per_cf:"", fuel_surcharge_pct:"", estimate:"", deposit:"", carrier_notes:"", extra_stops:"", pickup_date:"", pickup_date_from:"", pickup_date_to:"", pickup_address:"", pickup_city:"", pickup_state:"", pickup_zip:"", delivery_date:"", delivery_address:"", delivery_city:"", delivery_state:"", delivery_zip:"", billing_active:false, client_monthly_rate:"", first_month_free:false, billing_start_date:"", closing_sheet_id:"", carrier_rate_per_cf:"", bol_balance:"", bol_collected:"", bol_payment_method:"", bol_payment_notes:"", bol_collected_date:"", pads_received:"", pads_returned:"", broker_job_share_pct:"", notes:"" };

// A job physically occupies its storage/warehouse only while it's actually there:
// not delivered (date_out) and not already loaded onto a truck (out_for_delivery,
// or picked_up while riding a trip — the relocation leg between two locations).
const jobInStorageNow = (j) => !j.date_out && j.status !== "out_for_delivery" && !(j.trip_id && j.status === "picked_up");

// Purpose of a job's current trip assignment: 'relocation' = internal move between
// locations (no delivery, balances NOT collected on this trip); null/'delivery' = normal.
const isRelocation = (j) => j?.trip_purpose === "relocation";

// Trip-layer identity. Everything OUTSIDE trips groups a job by jobKey (job_number),
// so a job stays ONE job in billing/analytics/client view. But a split job has
// "portion" rows (same job_number) that must ride different trucks, so inside the
// Trips layer the assignment unit is the individual row. Non-split rows keep
// collapsing by jobKey (no regression); split portions are addressed by row id.
const tripUnitKey = (j) => j.split_group ? "row:" + j.id : jobKey(j);

// Order rows of a job so the money-bearing one comes first: non-split unit rows
// before split rows, then by id. Groupings that take job-level fields from the
// first row per jobKey must iterate in this order, else a zeroed split portion
// (created later, so newest-first in load order) could shadow the real balances.
const moneyRowFirst = (a, b) => ((a.split_group ? 1 : 0) - (b.split_group ? 1 : 0)) || (a.id - b.id);

// Total to collect from the client for a job: pickup + delivery balances
// (whichever the job type uses) plus the broker BOL balance. numv() treats
// blank/null as 0, so jobs with only one balance sum correctly. Split portions
// carry zeroed money fields (see splitJob), so per-row sums never double-count.
const jobToCollect = (j) => numv(j.pickup_balance) + numv(j.delivery_balance) + numv(j.bol_balance);

// Google Maps directions URL from the job's storage location to its delivery address.
const routeUrl = (g) => {
  const sp = g.parts.find(p => p.storage?.address);
  const origin = sp ? [sp.storage.address, sp.storage.state, sp.storage.zip].filter(Boolean).join(" ")
    : (g.parts.find(p => p.warehouse) ? `Warehouse ${g.parts.find(p => p.warehouse).warehouse}` : "");
  const dest = [g.delivery_address, g.delivery_state, g.delivery_zip].filter(Boolean).join(" ");
  if (!origin || !dest) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`;
};

// Audit trail: who created / last edited a record, and when (shown in light gray).
const fmtTs = (ts) => {
  if (!ts) return null;
  try { return new Date(ts).toLocaleString("es-AR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }); }
  catch { return ts; }
};
function AuditInfo({ rec }) {
  if (!rec || (!rec.created_by && !rec.updated_by && !rec.created_at)) return null;
  return (
    <div style={{ marginTop:14, paddingTop:10, borderTop:"1px solid #f5f5f5", fontSize:11, color:"#bbb", lineHeight:1.6 }}>
      {(rec.created_by || rec.created_at) && <div>Created by {rec.created_by || "—"}{rec.created_at ? ` · ${fmtTs(rec.created_at)}` : ""}</div>}
      {(rec.updated_by || rec.updated_at) && <div>Last edited by {rec.updated_by || "—"}{rec.updated_at ? ` · ${fmtTs(rec.updated_at)}` : ""}</div>}
    </div>
  );
}

// Payment due dates. If payment_due_date isn't set, derive it from date_opened
// + 30 days, rolled forward in 30-day steps until it lands on/after today.
const ONE_DAY = 86400000;
const fmtDateLocal = (d) => d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` : null;
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const addDaysStr = (dateStr, n) => { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return fmtDateLocal(d); };
function paymentDueDate(r) {
  if (!r) return null;
  if (r.payment_due_date) return new Date(r.payment_due_date + "T00:00:00");
  if (!r.date_opened) return null;
  const d = new Date(r.date_opened + "T00:00:00");
  d.setDate(d.getDate() + 30);
  const today = startOfToday();
  while (d < today) d.setDate(d.getDate() + 30);
  return d;
}
function daysUntilDue(r) {
  const due = paymentDueDate(r);
  if (!due) return null;
  return Math.round((due - startOfToday()) / ONE_DAY);
}
// Red ≤5 days, yellow 6–10, green 11+; gray "—" when the unit is Closed or Empty.
function PaymentBadge({ record, situation }) {
  if (situation === "Close" || situation === "Empty") return <span style={{ color:"#bbb" }}>—</span>;
  const days = daysUntilDue(record);
  if (days === null) return <span style={{ color:"#bbb" }}>—</span>;
  const c = days <= 5 ? { bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" }
          : days <= 10 ? { bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" }
          : { bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" };
  const label = days < 0 ? "Expired" : days === 0 ? "Today" : `${days} days`;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
      {label}
    </span>
  );
}

// FADD = First Available Delivery Date (per job). Drives dispatching urgency.
function daysUntilFadd(fadd) {
  if (!fadd) return null;
  return Math.round((new Date(fadd + "T00:00:00") - startOfToday()) / ONE_DAY);
}
function FaddBadge({ fadd }) {
  const days = daysUntilFadd(fadd);
  if (days === null) return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:"#f1f1f1", color:"#888", whiteSpace:"nowrap" }}>No FADD</span>;
  const c = days < 0 ? { bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" }
          : days <= 3 ? { bg:"#FDE3CF", text:"#C2410C", dot:"#EA580C" }
          : days <= 7 ? { bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" }
          : { bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" };
  const label = days < 0 ? "Overdue" : days === 0 ? "Today" : `${days} days`;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
      {label}
    </span>
  );
}

// Inline FADD: a "+ FADD" button when unset (quick date picker), or the badge
// (clickable to change) when set. Saves to all parts of the job.
function FaddCell({ group, onSet }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input type="date" autoFocus defaultValue={group.fadd || ""}
        onChange={e => { if (e.target.value) { onSet(group, e.target.value); setEditing(false); } }}
        onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
        style={{ fontSize:12, padding:"4px 6px", borderRadius:8, border:"1px solid #185FA5", outline:"none" }} />
    );
  }
  if (!group.fadd) {
    return (
      <button onClick={() => setEditing(true)}
        style={{ fontSize:11, fontWeight:600, padding:"3px 11px", borderRadius:20, border:"1px dashed #ccc", background:"#fff", color:"#888", cursor:"pointer", whiteSpace:"nowrap" }}>
        + FADD
      </button>
    );
  }
  return (
    <span onClick={() => setEditing(true)} style={{ cursor:"pointer" }} title="Cambiar FADD"><FaddBadge fadd={group.fadd} /></span>
  );
}

// One row of the "Entregas por agendar" panel on the delivery calendar: job info +
// FADD urgency + a date picker (defaults to max(FADD, today)) + one-click schedule.
// Module-level so the date input keeps focus across App re-renders (see FaddCell).
function ScheduleDeliveryRow({ cand, onSchedule, onOpen }) {
  const td = today();
  const [date, setDate] = useState((cand.fadd && cand.fadd > td) ? cand.fadd : td);
  const where = cand.warehouse ? `🏭 ${cand.warehouse}`
    : cand.storage_id ? "🏬 Storage"
    : [cand.delivery_city, cand.delivery_state].filter(Boolean).join(", ");
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", borderBottom:"1px solid #f6f6f6", fontSize:12.5, flexWrap:"wrap" }}>
      <button onClick={() => onOpen(cand.key)} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline", fontSize:12.5 }}>{cand.job_number || "(sin #)"}</button>
      <span style={{ color:"#555", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:180 }}>{cand.customer || "—"}</span>
      {cand.job_type === "broker_delivery" && <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:20, background:"#EDE9FE", color:"#6D28D9" }}>Broker</span>}
      <FaddBadge fadd={cand.fadd} />
      {where && <span style={{ color:"#999", fontSize:11.5 }}>{where}</span>}
      <span style={{ flex:1 }} />
      <input type="date" value={date} min={cand.fadd || undefined} onChange={e => setDate(e.target.value)}
        style={{ fontSize:12, padding:"4px 7px", borderRadius:7, border:"1px solid #ddd" }} />
      <Btn primary disabled={!date} onClick={() => onSchedule(cand, date)} style={{ padding:"5px 12px", fontSize:12 }}>Agendar</Btn>
    </div>
  );
}

// Click-to-edit field used in the job detail. Date inputs commit on change
// (the native calendar steals focus); text/datalist inputs commit on blur/Enter.
function InlineField({ value, onSave, type = "text", listId, placeholder = "—", display, transform, mono }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || "");
  useEffect(() => { setVal(value || ""); }, [value]);
  if (!editing) {
    return (
      <span onClick={() => { setVal(value || ""); setEditing(true); }} title="Click para editar"
        style={{ cursor:"pointer", borderBottom:"1px dashed #ddd", paddingBottom:1, fontFamily: mono ? "monospace" : undefined }}>
        {display != null ? display : (value ? value : <span style={{ color:"#bbb" }}>{placeholder}</span>)}
      </span>
    );
  }
  const commit = () => { const v = (transform ? transform(val) : val) || ""; if (v !== (value || "")) onSave(v); setEditing(false); };
  if (type === "date") {
    return (
      <input type="date" autoFocus value={val}
        onChange={e => { onSave(e.target.value); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
        style={{ fontSize:13, padding:"4px 8px", borderRadius:8, border:"1px solid #185FA5", outline:"none" }} />
    );
  }
  return (
    <input autoFocus list={listId} value={val}
      onChange={e => setVal(transform ? transform(e.target.value) : e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
      style={{ fontSize:13, padding:"4px 8px", borderRadius:8, border:"1px solid #185FA5", outline:"none", width:"100%", fontFamily: mono ? "monospace" : undefined }} />
  );
}
function EditRow({ label, children }) {
  return (
    <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13, alignItems:"center" }}>
      <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>{label}</span>
      <span style={{ fontWeight:500, flex:1 }}>{children}</span>
    </div>
  );
}

// ── Dispatching CRM: job types, statuses, badges, status flow, WhatsApp ──
// New columns on storage_jobs for the Dispatching CRM. DDL can't run via the
// anon key, so the app probes for `status` and shows this SQL if it's missing.
const JOB_COLS_SQL = `alter table public.storage_jobs
  add column if not exists job_type text,
  add column if not exists status text default 'scheduled',
  add column if not exists pickup_date date,
  add column if not exists pickup_address text,
  add column if not exists pickup_city text,
  add column if not exists pickup_state text,
  add column if not exists pickup_zip text,
  add column if not exists delivery_date date,
  add column if not exists delivery_city text,
  add column if not exists broker_job_share_pct numeric default 0,
  add column if not exists broker_job_share_amount numeric;`;
// brokers table + broker/balance columns on storage_jobs (CRM v2). The app probes
// the brokers table and the pickup_balance column; if missing it shows this SQL.
const CRM_V2_SQL = `create table if not exists public.brokers (
  id bigint generated always as identity primary key,
  name text,
  contact_name text,
  contact_phone text,
  contact_email text,
  notes text,
  created_at timestamptz default now()
);
alter table public.brokers enable row level security;
drop policy if exists "brokers_all" on public.brokers;
create policy "brokers_all" on public.brokers for all to anon, authenticated using (true) with check (true);

insert into public.brokers (name)
select v.name from (values
  ('Allied Van Lines'),('Atlas Van Lines'),('Mayflower'),('United Van Lines'),
  ('North American Van Lines'),('Wheaton'),('Arpin'),('Bekins'),('Direct (no broker)')
) as v(name)
where not exists (select 1 from public.brokers b where b.name = v.name);

alter table public.storage_jobs
  add column if not exists broker_id bigint references public.brokers(id),
  add column if not exists pickup_balance numeric,
  add column if not exists delivery_balance numeric;

do $$ begin
  alter publication supabase_realtime add table public.brokers;
exception when others then null; end $$;`;
// Storage occupancy + client storage billing (CRM v3). Probed via storage_billing
// table + storages.space_type + storage_jobs.billing_active.
const BILLING_SQL = `alter table public.storages
  add column if not exists space_type text,
  add column if not exists total_capacity_cf numeric;

alter table public.storage_jobs
  add column if not exists client_monthly_rate numeric,
  add column if not exists first_month_free boolean default false,
  add column if not exists billing_start_date date,
  add column if not exists billing_notes text,
  add column if not exists billing_active boolean default false;

create table if not exists public.storage_billing (
  id bigint generated always as identity primary key,
  job_id bigint references public.storage_jobs(id) on delete cascade,
  billing_period_start date,
  billing_period_end date,
  amount numeric,
  status text default 'pending',
  paid_date date,
  notes text,
  created_at timestamptz default now()
);
alter table public.storage_billing enable row level security;
drop policy if exists "storage_billing_all" on public.storage_billing;
create policy "storage_billing_all" on public.storage_billing for all to anon, authenticated using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table public.storage_billing;
exception when others then null; end $$;`;

// CRM v3: extra job fields (rep, financials, contacts, multi-driver) + drivers table.
const CRM_V3_SQL = `alter table public.storage_jobs
  add column if not exists rep text,
  add column if not exists extra_stops text,
  add column if not exists price_per_cf numeric,
  add column if not exists fuel_surcharge_pct numeric,
  add column if not exists estimate numeric,
  add column if not exists deposit numeric,
  add column if not exists carrier_notes text,
  add column if not exists client_phone text,
  add column if not exists client_email text,
  add column if not exists driver_ids bigint[],
  add column if not exists pickup_date_from date,
  add column if not exists pickup_date_to date,
  add column if not exists calendar_status text,
  add column if not exists real_cf numeric;

alter table public.storages add column if not exists payment_due_date date;

create table if not exists public.drivers (
  id bigint generated always as identity primary key,
  name text,
  phone text,
  whatsapp_group_link text,
  truck_id text,
  notes text,
  active boolean default true,
  created_at timestamptz default now()
);
alter table public.drivers enable row level security;
drop policy if exists "drivers_all" on public.drivers;
create policy "drivers_all" on public.drivers for all to anon, authenticated using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table public.drivers;
exception when others then null; end $$;`;

// Carrier Settlements: closing sheets + BOL collection fields + a public docs bucket.
const SETTLEMENTS_SQL = `create table if not exists public.closing_sheets (
  id bigint generated always as identity primary key,
  closing_sheet_number text,
  broker_id bigint references public.brokers(id),
  driver_id bigint references public.drivers(id),
  load_date date,
  status text default 'open',
  broker_payment_received boolean default false,
  broker_payment_date date,
  broker_payment_amount numeric,
  pads_sent integer default 0,
  pads_received integer default 0,
  charge_per_pad numeric default 7,
  trip_cost numeric default 0,
  labor_charges numeric default 0,
  other_fees numeric default 0,
  other_fees_description text,
  document_url text,
  notes text,
  created_at timestamptz default now()
);
alter table public.closing_sheets enable row level security;
drop policy if exists "closing_sheets_all" on public.closing_sheets;
create policy "closing_sheets_all" on public.closing_sheets for all to anon, authenticated using (true) with check (true);

alter table public.storage_jobs
  add column if not exists closing_sheet_id bigint references public.closing_sheets(id),
  add column if not exists carrier_rate_per_cf numeric,
  add column if not exists bol_balance numeric,
  add column if not exists bol_collected numeric default 0,
  add column if not exists bol_payment_method text,
  add column if not exists bol_payment_notes text,
  add column if not exists bol_collected_date date,
  add column if not exists pads_received integer default 0,
  add column if not exists pads_returned integer default 0;

insert into storage.buckets (id, name, public)
  values ('closing-sheet-docs', 'closing-sheet-docs', true)
  on conflict (id) do update set public = true;
drop policy if exists "csdocs_read" on storage.objects;
create policy "csdocs_read" on storage.objects for select to anon, authenticated using (bucket_id = 'closing-sheet-docs');
drop policy if exists "csdocs_write" on storage.objects;
create policy "csdocs_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'closing-sheet-docs');
drop policy if exists "csdocs_update" on storage.objects;
create policy "csdocs_update" on storage.objects for update to anon, authenticated using (bucket_id = 'closing-sheet-docs');

do $$ begin
  alter publication supabase_realtime add table public.closing_sheets;
exception when others then null; end $$;`;

// Trips / Live Load: trucks + trips tables + trip link columns on storage_jobs.
const TRIPS_SQL = `create table if not exists public.trucks (
  id bigint generated always as identity primary key,
  name text,
  plate text,
  capacity_cf numeric,
  notes text,
  active boolean default true,
  created_at timestamptz default now()
);
alter table public.trucks add column if not exists capacity_cf numeric;
alter table public.trucks add column if not exists vin text;
alter table public.trucks add column if not exists make text;
alter table public.trucks add column if not exists model text;
alter table public.trucks add column if not exists year integer;
alter table public.trucks add column if not exists license_plate text;
alter table public.trucks add column if not exists license_state text;
-- Live load / GPS: last known position per truck (manual now, Verizon API later).
alter table public.trucks add column if not exists last_lat numeric;
alter table public.trucks add column if not exists last_lng numeric;
alter table public.trucks add column if not exists last_location text;
alter table public.trucks add column if not exists last_location_at timestamptz;
alter table public.trucks add column if not exists last_status text;
alter table public.trucks add column if not exists verizon_vehicle_id text;
alter table public.trucks enable row level security;
drop policy if exists "trucks_all" on public.trucks;
create policy "trucks_all" on public.trucks for all to anon, authenticated using (true) with check (true);

create table if not exists public.trips (
  id bigint generated always as identity primary key,
  trip_number text,
  truck_id bigint references public.trucks(id),
  driver_id bigint references public.drivers(id),
  departure_date date,
  status text default 'loading',
  notes text,
  created_at timestamptz default now()
);
alter table public.trips enable row level security;
alter table public.trips add column if not exists trip_log jsonb default '[]'::jsonb;
drop policy if exists "trips_all" on public.trips;
create policy "trips_all" on public.trips for all to anon, authenticated using (true) with check (true);

alter table public.storage_jobs
  add column if not exists trip_id bigint references public.trips(id),
  add column if not exists trip_stop_order integer,
  add column if not exists split_group text,
  add column if not exists trip_purpose text;

-- Audit trail of dynamic changes while a trip is in transit.
create table if not exists public.trip_events (
  id bigint generated always as identity primary key,
  trip_id bigint references public.trips(id) on delete cascade,
  event_type text,
  job_id bigint references public.storage_jobs(id),
  storage_id bigint references public.storages(id),
  notes text,
  created_by text,
  created_at timestamptz default now()
);
alter table public.trip_events enable row level security;
drop policy if exists "trip_events_all" on public.trip_events;
create policy "trip_events_all" on public.trip_events for all to anon, authenticated using (true) with check (true);

do $$ begin alter publication supabase_realtime add table public.trucks; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.trips; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.trip_events; exception when others then null; end $$;`;

// Custom (non-job) stops on a trip: maintenance, DOT inspection, fuel, weigh
// station, rest, etc. Each has a category, an optional address and a note.
const TRIP_STOPS_SQL = `create table if not exists public.trip_stops (
  id bigint generated always as identity primary key,
  trip_id bigint references public.trips(id) on delete cascade,
  category text,
  address text,
  note text,
  stop_order integer,
  done boolean default false,
  created_by text,
  created_at timestamptz default now()
);
alter table public.trip_stops enable row level security;
drop policy if exists "trip_stops_all" on public.trip_stops;
create policy "trip_stops_all" on public.trip_stops for all to anon, authenticated using (true) with check (true);
do $$ begin alter publication supabase_realtime add table public.trip_stops; exception when others then null; end $$;`;

// Internal equipment / materials (pads, dollies, pallets, tools…): company cargo
// that lives at a storage unit or warehouse and can ride a trip between locations.
// Not customer jobs — no balances, no delivery semantics.
const EQUIPMENT_SQL = `create table if not exists public.equipment_items (
  id bigint generated always as identity primary key,
  name text,
  category text,
  quantity numeric default 1,
  storage_id bigint references public.storages(id),
  warehouse text,
  trip_id bigint references public.trips(id),
  status text default 'available',
  notes text,
  created_by text,
  created_at timestamptz default now(),
  updated_at timestamptz
);
alter table public.equipment_items enable row level security;
drop policy if exists "equipment_items_all" on public.equipment_items;
create policy "equipment_items_all" on public.equipment_items for all to anon, authenticated using (true) with check (true);
do $$ begin alter publication supabase_realtime add table public.equipment_items; exception when others then null; end $$;`;

// Manual per-job timeline events (logged directly on a job, no formal trip needed).
const JOB_EVENTS_SQL = `create table if not exists public.job_events (
  id bigint generated always as identity primary key,
  job_id bigint references public.storage_jobs(id) on delete cascade,
  event_date date,
  event_type text,
  notes text,
  storage_id bigint references public.storages(id),
  storage_label text,
  trip_ref text,
  created_by text,
  created_at timestamptz default now()
);
alter table public.job_events enable row level security;
drop policy if exists "job_events_all" on public.job_events;
create policy "job_events_all" on public.job_events for all to anon, authenticated using (true) with check (true);
do $$ begin alter publication supabase_realtime add table public.job_events; exception when others then null; end $$;`;

// Extras & Commissions: employees (reps) + per-job extras with commission split.
const EXTRAS_SQL = `create table if not exists public.employees (
  id bigint generated always as identity primary key,
  name text,
  role text,
  phone text,
  email text,
  active boolean default true,
  created_at timestamptz default now()
);
alter table public.employees enable row level security;
drop policy if exists "employees_all" on public.employees;
create policy "employees_all" on public.employees for all to anon, authenticated using (true) with check (true);

create table if not exists public.job_extras (
  id bigint generated always as identity primary key,
  job_id bigint references public.storage_jobs(id) on delete cascade,
  extra_type text,
  description text,
  amount numeric,
  generated_by text default 'driver_only',
  driver_id bigint references public.drivers(id),
  rep_id bigint references public.employees(id),
  driver_commission_pct numeric,
  rep_commission_pct numeric,
  driver_commission_amount numeric,
  rep_commission_amount numeric,
  company_amount numeric,
  active boolean default true,
  notes text,
  extra_cf_count numeric,
  extra_cf_rate numeric,
  extra_cf_subtotal numeric,
  fuel_surcharge_pct numeric default 0,
  fuel_surcharge_amount numeric,
  extra_total_with_fuel numeric,
  commission_base text,
  commission_base_amount numeric,
  source text default 'manual',
  payment_id bigint,
  created_at timestamptz default now()
);
alter table public.job_extras add column if not exists extra_cf_count numeric;
alter table public.job_extras add column if not exists extra_cf_rate numeric;
alter table public.job_extras add column if not exists extra_cf_subtotal numeric;
alter table public.job_extras add column if not exists fuel_surcharge_pct numeric default 0;
alter table public.job_extras add column if not exists fuel_surcharge_amount numeric;
alter table public.job_extras add column if not exists extra_total_with_fuel numeric;
alter table public.job_extras add column if not exists commission_base text;
alter table public.job_extras add column if not exists commission_base_amount numeric;
alter table public.job_extras add column if not exists source text default 'manual';
alter table public.job_extras add column if not exists payment_id bigint;
alter table public.job_extras add column if not exists broker_share_pct numeric default 0;
alter table public.job_extras add column if not exists broker_share_amount numeric;
alter table public.job_extras add column if not exists net_amount numeric;
alter table public.job_extras enable row level security;
drop policy if exists "job_extras_all" on public.job_extras;
create policy "job_extras_all" on public.job_extras for all to anon, authenticated using (true) with check (true);

do $$ begin alter publication supabase_realtime add table public.employees; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.job_extras; exception when others then null; end $$;`;

// Payments: every dollar in, who holds it, what's banked + bank accounts.
const PAYMENTS_SQL = `create table if not exists public.payment_accounts (
  id bigint generated always as identity primary key,
  name text,
  bank_name text,
  account_type text,
  account_last4 text,
  notes text,
  active boolean default true,
  created_at timestamptz default now()
);
alter table public.payment_accounts enable row level security;
drop policy if exists "payment_accounts_all" on public.payment_accounts;
create policy "payment_accounts_all" on public.payment_accounts for all to anon, authenticated using (true) with check (true);
insert into public.payment_accounts (name)
  select v from (values ('Main Account'), ('Operations Account')) as t(v)
  where not exists (select 1 from public.payment_accounts);

create table if not exists public.payments (
  id bigint generated always as identity primary key,
  job_id bigint references public.storage_jobs(id) on delete set null,
  payment_date date,
  amount numeric,
  concept text default 'job',
  method text,
  method_id text,
  check_type text,
  discount numeric default 0,
  discount_reason text,
  received boolean default false,
  received_date date,
  received_by text,
  cash_with_whom text,
  banked boolean default false,
  banked_date date,
  bank_account text,
  payment_stage text,
  split_group text,
  extra_type text,
  notes text,
  created_at timestamptz default now()
);
alter table public.payments add column if not exists payment_stage text;
alter table public.payments add column if not exists split_group text;
alter table public.payments add column if not exists extra_type text;
-- Detailed check / money order tracking + credit-card fee fields.
alter table public.payments add column if not exists check_serial text;
alter table public.payments add column if not exists check_transaction_number text;
alter table public.payments add column if not exists check_remitter text;
alter table public.payments add column if not exists check_purchased_by text;
alter table public.payments add column if not exists check_bank text;
alter table public.payments add column if not exists check_from text;
alter table public.payments add column if not exists check_routing text;
alter table public.payments add column if not exists check_account_last4 text;
alter table public.payments add column if not exists check_date date;
alter table public.payments add column if not exists check_memo text;
alter table public.payments add column if not exists check_photo_url text;
alter table public.payments add column if not exists mo_type text;
alter table public.payments add column if not exists mo_serial text;
alter table public.payments add column if not exists mo_date date;
alter table public.payments add column if not exists mo_post_office text;
alter table public.payments add column if not exists mo_from_name text;
alter table public.payments add column if not exists mo_from_address text;
alter table public.payments add column if not exists mo_payment_for text;
alter table public.payments add column if not exists mo_issuer_location text;
alter table public.payments add column if not exists mo_photo_url text;
alter table public.payments add column if not exists cc_fee_enabled boolean default false;
alter table public.payments add column if not exists cc_fee_pct numeric default 3;
alter table public.payments add column if not exists cc_fee_amount numeric;
alter table public.payments add column if not exists cc_fee_payment_id bigint;
alter table public.payments add column if not exists job_extra_id bigint;
alter table public.payments enable row level security;
drop policy if exists "payments_all" on public.payments;
create policy "payments_all" on public.payments for all to anon, authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
  values ('payment-docs', 'payment-docs', true)
  on conflict (id) do update set public = true;
drop policy if exists "paydocs_read" on storage.objects;
create policy "paydocs_read" on storage.objects for select to anon, authenticated using (bucket_id = 'payment-docs');
drop policy if exists "paydocs_write" on storage.objects;
create policy "paydocs_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'payment-docs');
drop policy if exists "paydocs_update" on storage.objects;
create policy "paydocs_update" on storage.objects for update to anon, authenticated using (bucket_id = 'payment-docs');

do $$ begin alter publication supabase_realtime add table public.payment_accounts; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.payments; exception when others then null; end $$;`;

// Legal & Compliance: companies + compliance documents + a public docs bucket.
const COMPLIANCE_SQL = `create table if not exists public.companies (
  id bigint generated always as identity primary key,
  name text,
  dot_number text,
  mc_number text,
  ein text,
  state text,
  address text,
  phone text,
  email text,
  active boolean default true,
  notes text,
  created_at timestamptz default now()
);
alter table public.companies enable row level security;
drop policy if exists "companies_all" on public.companies;
create policy "companies_all" on public.companies for all to anon, authenticated using (true) with check (true);

create table if not exists public.compliance_documents (
  id bigint generated always as identity primary key,
  entity_type text,
  entity_id bigint,
  document_type text,
  document_name text,
  document_number text,
  issuer text,
  issue_date date,
  expiry_date date,
  status text,
  document_url text,
  notes text,
  created_at timestamptz default now()
);
alter table public.compliance_documents enable row level security;
drop policy if exists "compliance_documents_all" on public.compliance_documents;
create policy "compliance_documents_all" on public.compliance_documents for all to anon, authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
  values ('compliance-docs', 'compliance-docs', true)
  on conflict (id) do update set public = true;
drop policy if exists "compdocs_read" on storage.objects;
create policy "compdocs_read" on storage.objects for select to anon, authenticated using (bucket_id = 'compliance-docs');
drop policy if exists "compdocs_write" on storage.objects;
create policy "compdocs_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'compliance-docs');
drop policy if exists "compdocs_update" on storage.objects;
create policy "compdocs_update" on storage.objects for update to anon, authenticated using (bucket_id = 'compliance-docs');

do $$ begin alter publication supabase_realtime add table public.companies; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.compliance_documents; exception when others then null; end $$;`;

// Cubic feet stored in a job: volume is free text ("1200 cu ft / 5 pallets"),
// so pull the first number for occupancy math.
// Occupancy colors: green <70%, amber 70–90%, red >90%.
const occColor = (pct) => pct > 90 ? "#E24B4A" : pct >= 70 ? "#EF9F27" : "#639922";
function OccupancyBar({ used, total, height = 8 }) {
  if (!total || total <= 0) return null;
  const pct = Math.min(100, Math.round((used / total) * 100));
  return (
    <div style={{ minWidth:90 }}>
      <div style={{ background:"#f0f0f0", borderRadius:6, height, overflow:"hidden" }}>
        <div style={{ background:occColor(pct), height, width:`${pct}%`, transition:"width .4s" }} />
      </div>
      <div style={{ fontSize:10, color:"#888", marginTop:3, whiteSpace:"nowrap" }}>{pct}% · {Math.round(used).toLocaleString()}/{Math.round(total).toLocaleString()} CF</div>
    </div>
  );
}


// ── Custom trip stops (non-job): categories with icon + color ──
// Used for the "Add stop" button on each trip card: maintenance, inspections,
// fuel, weigh stations, rest breaks, etc. — anything that isn't a job pickup/drop.
// Source labels are English; `es` is the Spanish translation, picked via lang.
const TRIP_STOP_CATEGORIES = [
  { key:"maintenance",  label:"Maintenance",           es:"Mantenimiento",        icon:"🔧", color:"#185FA5" },
  { key:"repair",       label:"Repair",                es:"Reparación",           icon:"🛠️", color:"#A32D2D" },
  { key:"inspection",   label:"DOT inspection",        es:"Inspección DOT",       icon:"🔍", color:"#7C3AED" },
  { key:"scale",        label:"Weigh station",         es:"Báscula",              icon:"⚖️", color:"#B4690E" },
  { key:"fuel",         label:"Fuel",                  es:"Combustible",          icon:"⛽", color:"#1A8A4E" },
  { key:"rest",         label:"Rest (DOT hours)",      es:"Descanso (horas DOT)", icon:"🛌", color:"#3B6D11" },
  { key:"overnight",    label:"Overnight / parking",   es:"Pernocta / parking",   icon:"🅿️", color:"#4B5563" },
  { key:"equipment",    label:"Equipment (pads/dollies)", es:"Equipo (pads/dollies)", icon:"🚚", color:"#B4690E" },
  { key:"office",       label:"Office / terminal",     es:"Oficina / terminal",   icon:"🏢", color:"#185FA5" },
  { key:"other",        label:"Other",                 es:"Otro",                 icon:"📋", color:"#888888" },
];
const tripStopCat = (k) => TRIP_STOP_CATEGORIES.find(c => c.key === k) || TRIP_STOP_CATEGORIES[TRIP_STOP_CATEGORIES.length - 1];

// Internal equipment / materials categories (Equipment tab — company cargo, not jobs).
const EQUIPMENT_CATEGORIES = [
  { key:"pads",     label:"Pads / blankets", es:"Pads / mantas",     icon:"🧺", color:"#185FA5" },
  { key:"dollies",  label:"Dollies",         es:"Dollies",           icon:"🛒", color:"#7C3AED" },
  { key:"straps",   label:"Straps",          es:"Correas",           icon:"🪢", color:"#B4690E" },
  { key:"pallets",  label:"Pallets",         es:"Pallets",           icon:"🪵", color:"#3B6D11" },
  { key:"boxes",    label:"Boxes / packing", es:"Cajas / embalaje",  icon:"📦", color:"#1A8A4E" },
  { key:"tools",    label:"Tools",           es:"Herramientas",      icon:"🛠️", color:"#A32D2D" },
  { key:"other",    label:"Other",           es:"Otro",              icon:"🧰", color:"#888888" },
];
const equipmentCat = (k) => EQUIPMENT_CATEGORIES.find(c => c.key === k) || EQUIPMENT_CATEGORIES[EQUIPMENT_CATEGORIES.length - 1];
const EMPTY_EQUIPMENT = { name:"", category:"pads", quantity:"1", location:"", notes:"" };

// ── Live-load map: truck GPS status colors + relative-time helper ──
const LIVE_STATUS = {
  moving:  { l:"Moving", dot:"#1A8A4E", bg:"#EAF3DE", text:"#3B6D11" },
  stopped: { l:"Detenido", dot:"#E24B4A", bg:"#FCEBEB", text:"#A32D2D" },
  unknown: { l:"No data", dot:"#9aa3ad", bg:"#f1f1f1", text:"#888" },
};
const liveStatusMeta = (s) => LIVE_STATUS[s] || LIVE_STATUS.unknown;
function timeAgo(iso) {
  if (!iso) return "not updated";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "not updated";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.round(hrs / 24)} d`;
}

// Verizon-style live map: every truck with a known position plotted on the US map.
function TruckLiveMap({ trucks, selected, onSelect }) {
  const wrapRef = useRef();
  return (
    <div ref={wrapRef} style={{ position:"relative", background:"#eaf3fb", border:"1px solid #efefef", borderRadius:12, overflow:"hidden" }}>
      <ComposableMap projection="geoAlbersUsa" projectionConfig={{ scale: 1000 }} width={800} height={500} style={{ width:"100%", height:"auto" }}>
        <Geographies geography={US_GEO_URL}>
          {({ geographies }) => geographies.map(geo => (
            <Geography key={geo.rsmKey} geography={geo}
              style={{
                default: { fill:"#f3f6e9", stroke:"#cdd8e3", strokeWidth:0.6, outline:"none" },
                hover:   { fill:"#f3f6e9", stroke:"#cdd8e3", strokeWidth:0.6, outline:"none" },
                pressed: { fill:"#f3f6e9", stroke:"#cdd8e3", strokeWidth:0.6, outline:"none" },
              }} />
          ))}
        </Geographies>
        {trucks.map(t => {
          if (t.last_lat == null || t.last_lng == null) return null;
          const c = liveStatusMeta(t.last_status);
          const isSel = selected === t.id;
          return (
            <Marker key={t.id} coordinates={[Number(t.last_lng), Number(t.last_lat)]} onClick={() => onSelect(isSel ? null : t.id)}>
              <g style={{ cursor:"pointer" }}>
                {isSel && <circle r={11} fill={c.dot} opacity={0.25} />}
                <circle r={6} fill={c.dot} stroke="#fff" strokeWidth={1.6} />
                {isSel && <text textAnchor="middle" y={-12} style={{ fontSize:9, fontWeight:700, fill:"#111", paintOrder:"stroke", stroke:"#fff", strokeWidth:2.5 }}>{t.name}</text>}
              </g>
            </Marker>
          );
        })}
      </ComposableMap>
    </div>
  );
}

const BILLING_STATUS = {
  pending: { l:"Pending", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" },
  overdue: { l:"Overdue", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
  paid:    { l:"Paid", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
};
// Activate / edit monthly storage billing for a job.
const EMPTY_BILLING_FORM = { jobKey:"", job_id:"", customer:"", job_number:"", client_monthly_rate:"", first_month_free:false, billing_start_date:"", billing_notes:"", editing:false };
function BillingBadge({ status }) {
  const c = BILLING_STATUS[status] || BILLING_STATUS.pending;
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />{c.l}</span>;
}
// Client-facing reminder — NEVER mentions storage location / unit / brand / warehouse.
// Just the amount due, the period, and a contact request.
function billingReminderLink(b) {
  const amount = Number(b.amount || 0).toLocaleString();
  const ps = b.billing_period_start || b.period_start || "-";
  const pe = b.billing_period_end || b.period_end || "-";
  const txt = `Hi ${b.customer || "there"}, this is a reminder that your monthly storage fee of $${amount} is due for the period ${ps} to ${pe}. Please contact us to arrange payment. Thank you — No Borders Moving & Storage`;
  return "https://wa.me/?text=" + encodeURIComponent(txt);
}
function settlementWaLink(sheet, calc, brokerName, driverName) {
  const m = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const netResult = calc.net >= 0 ? `Broker owes you ${m(calc.net)}` : `You owe the broker ${m(-calc.net)}`;
  const txt = [
    `Closing Sheet #${sheet.closing_sheet_number || "-"} — ${brokerName || "-"}`,
    `Load date: ${sheet.load_date || "-"} | Driver: ${driverName || "-"}`,
    `Jobs: ${calc.jobCount} | Total CF: ${Math.round(calc.totalCf)}`,
    ``,
    `Carrier fee: ${m(calc.carrierFee)}`,
    `Deductions: -${m(calc.deductions)}`,
    `Net owed to us: ${m(calc.netCarrier)}`,
    ``,
    `BOL collected from clients: ${m(calc.bolCollected)}`,
    `Pending collections: ${m(calc.pending)}`,
    ``,
    `Settlement: ${netResult}`,
  ].join("\n");
  return "https://wa.me/?text=" + encodeURIComponent(txt);
}
// Full trip manifest to the driver's WhatsApp group (jobsIn already ordered by stop).
function tripManifestText(trip, truckName, driverName, jobsIn, totalCf, occPct, totalCollect) {
  const lines = [
    `TRIP #${trip.trip_number || "-"} — ${truckName || "-"}`,
    `Driver: ${driverName || "-"} | Departure: ${trip.departure_date || "-"}`,
    `Total load: ${Math.round(totalCf || 0)} CF (${occPct != null ? occPct + "% capacity" : "—"})`,
    `Total to collect: $${Math.round(totalCollect || 0).toLocaleString()}`,
    ``,
    `STOPS:`,
  ];
  jobsIn.forEach((j, i) => {
    lines.push(`${i + 1}. Job ${j.job_number || "-"} — ${j.customer || "-"}${j.split_group ? " (split load — partial)" : ""}${isRelocation(j) ? " (RELOCATION)" : ""}`);
    if (isRelocation(j)) {
      lines.push(`   Move to: storage/warehouse (relocation)`);
      lines.push(`   FADD: ${j.fadd || "-"} | CF: ${Math.round(effCf(j))} | Sticker: ${j.sticker_color || "-"} Lot ${j.lot_number || "-"}`);
      lines.push(`   RELOCATION — move to storage. DO NOT COLLECT.`);
    } else {
      lines.push(`   Delivery: ${[j.delivery_address, j.delivery_city, j.delivery_state].filter(Boolean).join(", ") || "-"}`);
      lines.push(`   FADD: ${j.fadd || "-"} | CF: ${Math.round(effCf(j))} | Sticker: ${j.sticker_color || "-"} Lot ${j.lot_number || "-"}`);
      lines.push(`   Balance to collect: $${Math.round(jobToCollect(j)).toLocaleString()}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}
const tripManifestLink = (...args) => "https://wa.me/?text=" + encodeURIComponent(tripManifestText(...args));

// Placeholder street values that aren't real addresses and break geocoding.
const isPlaceholderAddr = (a) => /^(tbd|t\.?b\.?d\.?|n\/?a|na|none|-+|\.+|\?+|unknown|pending|same|house)$/i.test((a || "").trim());
// Human-readable address (2-letter state → full name so the geocoder doesn't
// confuse "OK"/"ID"/etc. with words).
function fmtPlace({ address, city, state, zip }) {
  const st = (state || "").trim();
  const stateName = US_CODE_TO_NAME[st.toUpperCase()] || st;
  return [address, city, stateName, zip].filter(Boolean).join(", ");
}
// Geocoding candidates from most to least specific, so a bad/placeholder street
// still resolves to the city, zip, or at least the state centroid.
function geoCandidates({ address, city, state, zip }) {
  const st = (state || "").trim();
  const stateName = US_CODE_TO_NAME[st.toUpperCase()] || st;
  const addr = isPlaceholderAddr(address) ? "" : (address || "").trim();
  const c = (city || "").trim();
  const z = (zip || "").trim();
  const out = [];
  const push = (parts) => { const q = parts.filter(Boolean).join(", "); if (q && !out.includes(q)) out.push(q); };
  push([addr, c, stateName, z]);
  push([c, stateName, z]);
  push([z, stateName]);
  push([c, stateName]);
  push([stateName]);
  return out;
}
function deliveryQuery(j) {
  return fmtPlace({ address: j.delivery_address, city: j.delivery_city, state: j.delivery_state, zip: j.delivery_zip });
}
// Where a job was actually loaded from: storage unit → warehouse → the job's own
// pickup address (matching how routeUrl resolves origin). Returns null if unknown.
function jobOrigin(j, storageById) {
  const st = j.storage_id ? ((storageById || {})[j.storage_id] || null) : null;
  if (st && (st.address || st.state || st.zip)) {
    return { kind: "storage", label: [st.brand, st.unit].filter(Boolean).join(" ") || "Storage",
      query: fmtPlace({ address: st.address, state: st.state, zip: st.zip }),
      candidates: geoCandidates({ address: st.address, state: st.state, zip: st.zip }) };
  }
  if (j.warehouse) {
    return { kind: "warehouse", label: `Warehouse ${j.warehouse}`, query: j.warehouse, candidates: [j.warehouse].filter(Boolean) };
  }
  const candidates = geoCandidates({ address: j.pickup_address, city: j.pickup_city, state: j.pickup_state, zip: j.pickup_zip });
  if (!candidates.length) return null;
  return { kind: "pickup", label: "Pickup", query: fmtPlace({ address: j.pickup_address, city: j.pickup_city, state: j.pickup_state, zip: j.pickup_zip }), candidates };
}
// The full journey the truck made: for each stop (in trip order) a pickup/origin
// waypoint (where it was loaded) followed by the delivery waypoint. Jobs with no
// delivery location still yield a (non-locatable) delivery waypoint so they're listed.
function tripRouteWaypoints(jobsIn, storageById) {
  const wps = [];
  (jobsIn || []).forEach((j, idx) => {
    const jobNumber = j.job_number || "(job)";
    const customer = j.customer || "";
    const o = jobOrigin(j, storageById);
    if (o) wps.push({ type: "pickup", stop: idx + 1, jobNumber, customer, sourceKind: o.kind, sourceLabel: o.label, query: o.query, candidates: o.candidates });
    wps.push({ type: "delivery", stop: idx + 1, jobNumber, customer, query: deliveryQuery(j), candidates: geoCandidates({ address: j.delivery_address, city: j.delivery_city, state: j.delivery_state, zip: j.delivery_zip }) });
  });
  return wps;
}
// Google Maps directions link through every locatable waypoint, in journey order.
function tripRouteLink(jobsIn, storageById) {
  const wps = tripRouteWaypoints(jobsIn, storageById).filter(w => w.candidates.length);
  if (wps.length < 2) return null;
  return "https://www.google.com/maps/dir/" + wps.map(w => encodeURIComponent(w.query || w.candidates[0])).join("/");
}

// WhatsApp "trip update" sent to the driver group when a job is added mid-trip.
function tripUpdateWaText(trip, g, totalCf) {
  const dest = [g.delivery_address, g.delivery_city, g.delivery_state].filter(Boolean).join(", ");
  const pick = [g.pickup_address, g.pickup_city, g.pickup_state].filter(Boolean).join(", ");
  return [
    `🔄 TRIP #${trip.trip_number || trip.id} UPDATE`,
    `New job added to your trip:`,
    `Job: ${g.job_number || "-"} — ${g.customer || "-"}${isRelocation(g) ? " (RELOCATION)" : ""}`,
    `Pickup/delivery: ${dest || pick || "-"}`,
    `CF: ${Math.round(effCf(g))} | Sticker: ${g.sticker_color || "-"} Lot ${g.lot_number || "-"}`,
    isRelocation(g) ? `RELOCATION — move to storage. DO NOT COLLECT.` : `Balance to collect: $${numv(g.bol_balance).toLocaleString()}`,
    `Updated total load: ${Math.round(totalCf || 0)} CF`,
  ].join("\n");
}
const tripUpdateWaLink = (...args) => "https://wa.me/?text=" + encodeURIComponent(tripUpdateWaText(...args));
// Trip event-log metadata: label + icon + who-by-default.
const TRIP_EVENT_META = {
  job_added:          { l:"Job added", icon:"➕" },
  job_removed:        { l:"Job removed", icon:"➖" },
  storage_drop:       { l:"Dropped at storage", icon:"📦" },
  storage_pickup:     { l:"Loaded from storage", icon:"🔼" },
  unplanned_pickup:   { l:"Unplanned pickup", icon:"🆕" },
  delivery_completed: { l:"Delivered", icon:"✅" },
  driver_handoff:     { l:"Handoff de driver", icon:"🔄" },
  equipment_loaded:   { l:"Equipment loaded", icon:"🧰" },
  equipment_unloaded: { l:"Equipment unloaded", icon:"📤" },
};
const tripEventLabel = (v) => TRIP_EVENT_META[v]?.l || v;
// Why a driver handed a job (or the whole trip) to another driver.
const HANDOFF_REASONS = [
  ["better_fit", "Mejor para esta entrega"],
  ["truck_swap", "Cambio de camión"],
  ["availability", "Disponibilidad"],
  ["other", "Otro"],
];
const handoffReasonLabel = (v) => HANDOFF_REASONS.find(r => r[0] === v)?.[1] || v;
const EMPTY_UNPLANNED = { job_number:"", customer:"", volume:"", pickup_address:"", delivery_address:"", fadd:"", broker_id:"", sticker_color:"", lot_number:"" };

// Manual job-timeline event types (logged directly on a job). `status` = the job
// status this event optionally suggests; `storage` = show the storage selector.
const JOB_EVENT_TYPES = [
  { v:"picked_up", l:"Picked up", icon:"📦", status:"picked_up" },
  { v:"loaded_to_truck", l:"Loaded to truck", icon:"🚚", status:"out_for_delivery", storage:true },
  { v:"dropped_at_storage", l:"Dropped at storage", icon:"🏬", status:"in_storage", storage:true },
  { v:"loaded_from_storage", l:"Loaded from storage to truck", icon:"🔼", storage:true },
  { v:"delivered", l:"Delivered", icon:"✅", status:"delivered" },
  { v:"on_hold", l:"On hold", icon:"⏸️" },
  { v:"attempted_delivery", l:"Attempted delivery — not home", icon:"🚪" },
  { v:"redispatched", l:"Redispatched", icon:"🔁" },
  { v:"driver_handoff", l:"Handoff de driver", icon:"🔄" },
  { v:"other", l:"Other", icon:"📝" },
];
const jobEventMeta = (v) => JOB_EVENT_TYPES.find(t => t.v === v) || { l: v || "Evento", icon:"•" };

const JOB_TYPES = [{ v:"full", l:"Full" }, { v:"direct", l:"Direct" }, { v:"broker_delivery", l:"Broker" }];
const jobTypeLabel = (v) => (JOB_TYPES.find(t => t.v === v)?.l) || "—";
function StatusBadge({ status }) {
  const c = statusMeta(status || "scheduled");
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />{c.l}</span>;
}
function TypeBadge({ type }) {
  if (!type) return <span style={{ color:"#bbb" }}>—</span>;
  const colors = { full:{ bg:"#E6F1FB", text:"#185FA5" }, direct:{ bg:"#EAF3DE", text:"#3B6D11" }, broker_delivery:{ bg:"#FDE3CF", text:"#C2410C" } };
  const c = colors[type] || { bg:"#f1f1f1", text:"#888" };
  return <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:6, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>{jobTypeLabel(type)}</span>;
}
function nextStatus(g) {
  const s = g.status || "scheduled";
  if (s === "scheduled") return "picked_up";
  if (s === "picked_up") return g.job_type === "full" ? "in_storage" : "out_for_delivery";
  if (s === "in_storage") return "out_for_delivery";
  if (s === "out_for_delivery") return "delivered";
  return null;
}

// ── List pagination: 15 rows per page, prev/next arrows. Filters run over the
// full set first; only the page slice is rendered. ──
const PAGE_SIZE = 15;
function Pager({ page, total, onPage, pageSize = PAGE_SIZE, unit = "records" }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, pages - 1);
  const from = total === 0 ? 0 : cur * pageSize + 1;
  const to = Math.min(total, (cur + 1) * pageSize);
  const btn = (disabled) => ({ border:"1px solid #e5e5e5", background: disabled ? "#f7f7f7" : "#fff", color: disabled ? "#ccc" : "#444", borderRadius:7, minWidth:30, height:28, cursor: disabled ? "default" : "pointer", fontSize:15, lineHeight:1, display:"inline-flex", alignItems:"center", justifyContent:"center" });
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, flexWrap:"wrap" }}>
      <span style={{ fontSize:12, color:"#bbb" }}>{from}–{to} of {total} {unit}</span>
      {pages > 1 && (
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <button disabled={cur <= 0} onClick={() => onPage(cur - 1)} style={btn(cur <= 0)} title="Anterior">←</button>
          <span style={{ fontSize:12, color:"#666", minWidth:54, textAlign:"center" }}>{cur + 1} / {pages}</span>
          <button disabled={cur >= pages - 1} onClick={() => onPage(cur + 1)} style={btn(cur >= pages - 1)} title="Siguiente">→</button>
        </div>
      )}
    </div>
  );
}

// ── Calendar helpers (Sunday-start) ──
function weekDays(anchorStr) {
  const d = new Date(anchorStr + "T00:00:00");
  const start = new Date(d); start.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(start); x.setDate(start.getDate() + i); return fmtDateLocal(x); });
}
function monthGrid(anchorStr) {
  const d = new Date(anchorStr + "T00:00:00");
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => { const x = new Date(gridStart); x.setDate(gridStart.getDate() + i); return { date: fmtDateLocal(x), inMonth: x.getMonth() === d.getMonth() }; });
}
function shiftDate(anchorStr, days) { const x = new Date(anchorStr + "T00:00:00"); x.setDate(x.getDate() + days); return fmtDateLocal(x); }
const MONTHS_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DOW_ES = ["Dom","Lun","Mar","Wed","Jue","Vie","Sat"];
// Calendar colour is driven ONLY by this manual field — never inferred from the
// workflow status, delivery, or trip actions. The five options match the legend.
const CALENDAR_STATUSES = [
  { v:"active",    l:"Active",                bg:"#EAF3DE", text:"#3B6D11", bar:"#639922" }, // green
  { v:"on_hold",   l:"On hold / Redispatch",  bg:"#FEF9C3", text:"#854D0E", bar:"#FACC15" }, // yellow
  { v:"cancelled", l:"Cancelled",             bg:"#FCEBEB", text:"#A32D2D", bar:"#E24B4A" }, // red
  { v:"long_haul", l:"Long haul",             bg:"#EDE9FE", text:"#6D28D9", bar:"#7C3AED" }, // purple
  { v:"delivered", l:"Delivered",             bg:"#E6F1FB", text:"#185FA5", bar:"#378ADD" }, // blue
];
const calStatusMeta = (v) => CALENDAR_STATUSES.find(s => s.v === v) || null;
// Legacy fallback used ONLY to seed a calendar_status for jobs created before the
// field existed (and to keep their current colour until the user changes it). Once
// a job has an explicit calendar_status, this is never consulted again.
function legacyCalKey(g) {
  const s = g.status || "scheduled";
  if (s === "cancelled") return "cancelled";
  if (s === "delivered") return "delivered";
  if (s === "on_hold" || s === "redispatched") return "on_hold";
  if (s === "in_storage" || s === "out_for_delivery") return "long_haul";
  return "active"; // scheduled, picked_up, unknown / null → green
}
// The effective calendar status: the manual field if set, otherwise the legacy seed.
const calStatusOf = (g) => (calStatusMeta(g.calendar_status) ? g.calendar_status : legacyCalKey(g));
function calEventColor(g) {
  const c = calStatusMeta(calStatusOf(g)) || CALENDAR_STATUSES[0];
  return { bg:c.bg, text:c.text, bar:c.bar };
}
function waLink(g, storeLabel, brokerName, groupLink) {
  const pickup = [g.pickup_address, g.pickup_city, g.pickup_state, g.pickup_zip].filter(Boolean).join(", ");
  const delivery = [g.delivery_address, g.delivery_city, g.delivery_state].filter(Boolean).join(", ");
  const txt = [
    `Job: ${g.job_number || "-"}`,
    `Customer: ${g.customer || "-"} | Ph: ${g.client_phone || "-"}`,
    `Broker: ${brokerName || "-"} | Rep: ${g.rep || "-"}`,
    `Pick up: ${pickup || "-"}`,
    `Extra stops: ${g.extra_stops || "-"}`,
    `Delivery: ${delivery || "-"}`,
    `FADD: ${g.fadd || "-"}`,
    `Volume: ${g.volume || "-"} CF | Price/CF: ${money(g.price_per_cf) || "-"}`,
    `Sticker: ${g.sticker_color || "-"} - Lot ${g.lot_number || "-"}`,
    `Storage: ${storeLabel || "-"}`,
    `Due at pick up: ${money(g.pickup_balance) || "$0"}`,
    `Due at delivery: ${money(g.delivery_balance) || "$0"}`,
    `Carrier notes: ${g.carrier_notes || "-"}`,
  ].join("\n");
  // If we have the driver group's chat link, the message can't be auto-injected into a
  // group invite, so fall back to wa.me share which lets the dispatcher pick the group.
  return "https://wa.me/?text=" + encodeURIComponent(txt);
}

// Sticker color: stored as free text, with a color swatch for the known names.
const STICKER_COLORS = ["Rojo","Azul","Verde","Amarillo","Naranja","Rosa","Violeta","Blanco","Negro","Gris","Brown"];
const COLOR_MAP = { rojo:"#e24b4a", red:"#e24b4a", azul:"#185FA5", blue:"#185FA5", verde:"#3B6D11", green:"#3B6D11", amarillo:"#EAB308", yellow:"#EAB308", naranja:"#EA7C27", orange:"#EA7C27", rosa:"#EC4899", pink:"#EC4899", violeta:"#7C3AED", purple:"#7C3AED", blanco:"#FFFFFF", white:"#FFFFFF", negro:"#111111", black:"#111111", gris:"#888888", gray:"#888888", "marrón":"#92400E", marron:"#92400E", brown:"#92400E" };
const colorHex = (name) => { if (!name) return null; const k = name.trim().toLowerCase(); return COLOR_MAP[k] || null; };

function Sticker({ color }) {
  if (!color) return <span>—</span>;
  const hex = colorHex(color);
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:6, whiteSpace:"nowrap" }}>
      <span style={{ width:12, height:12, borderRadius:"50%", flexShrink:0, background: hex || "#fff", border:"1px solid #ccc" }} />
      {color}
    </span>
  );
}


const sitColor = {
  Open:  { bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  Close: { bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
  Empty: { bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" },
};

const Badge = ({ situation }) => {
  const c = sitColor[situation] || sitColor.Open;
  const label = situation === "Close" ? "Closed" : situation === "Empty" ? "Empty" : "Active";
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:500, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
      {label}
    </span>
  );
};

const CopyButton = ({ value }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      onClick={copy}
      title={copied ? "Copiado" : "Copiar gate code"}
      style={{ flexShrink:0, marginLeft:6, padding:0, width:18, height:18, lineHeight:"18px", border:"none", background:"none", cursor:"pointer", color:copied?"#16a34a":"#bbb", fontSize:11, opacity:0.8 }}
      onMouseEnter={e => e.currentTarget.style.opacity=1}
      onMouseLeave={e => e.currentTarget.style.opacity=0.8}>
      {copied ? "✓" : "⧉"}
    </button>
  );
};

const DetailRow = ({ label, value }) => {
  if (!value) return null;
  return (
    <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}>
      <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>{label}</span>
      <span style={{ fontWeight:500, wordBreak:"break-all" }}>{value}</span>
    </div>
  );
};

const SectionLabel = ({ children }) => (
  <div style={{ fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em", margin:"14px 0 6px" }}>{children}</div>
);

const Field = ({ label, children, full }) => (
  <div style={{ gridColumn: full ? "1/-1" : undefined, display:"flex", flexDirection:"column", gap:4 }}>
    <label style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</label>
    {children}
  </div>
);

// Debounce a value: returns [debouncedValue, pending]. `pending` is true while the
// user is still typing (within the delay window) — used to show a checking spinner.
function useDebounced(value, delay = 500) {
  const [debounced, setDebounced] = useState(value);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (value === debounced) { setPending(false); return; }
    setPending(true);
    const t = setTimeout(() => { setDebounced(value); setPending(false); }, delay);
    return () => clearTimeout(t);
  }, [value, delay, debounced]);
  return [debounced, pending];
}
// Inline, non-blocking duplicate hint shown below a form field. Never a popup.
function DupHint({ checking, tone = "warn", children }) {
  if (checking) return (
    <div style={{ fontSize:11, color:"#999", marginTop:4, display:"flex", alignItems:"center", gap:6 }}>
      <span style={{ width:11, height:11, border:"2px solid #eee", borderTop:"2px solid #999", borderRadius:"50%", display:"inline-block", animation:"spin 0.7s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      Verificando…
    </div>
  );
  if (!children) return null;
  const c = tone === "ok" ? { bg:"#EAF3DE", bd:"#639922", fg:"#3B6D11" }
    : tone === "danger" ? { bg:"#FCEBEB", bd:"#E24B4A", fg:"#A32D2D" }
    : { bg:"#FFF6E8", bd:"#F4DDB0", fg:"#B45309" };
  return <div style={{ fontSize:11.5, marginTop:5, background:c.bg, border:`1px solid ${c.bd}`, color:c.fg, borderRadius:7, padding:"6px 9px", lineHeight:1.45 }}>{children}</div>;
}

// Collapsible titled section for the job form. Responsive grids stack on mobile.
function FormSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderTop:"1px solid #f0f0f0", marginTop:12, paddingTop:4 }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ width:"100%", display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", padding:"8px 0", textAlign:"left" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"#666", textTransform:"uppercase", letterSpacing:"0.07em" }}>{title}</span>
        <span style={{ flex:1 }} />
        <span style={{ color:"#bbb", fontSize:11, transform: open ? "rotate(90deg)" : "none", transition:"transform .15s" }}>▸</span>
      </button>
      {open && <div style={{ paddingBottom:6 }}>{children}</div>}
    </div>
  );
}
const fgrid = { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:10 };

const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none" };

function Btn({ onClick, primary, danger, disabled, children, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ fontSize:13, fontWeight:500, padding:"8px 16px", borderRadius:8, border: danger ? "1px solid #fca5a5" : "1px solid #e5e5e5", background: primary ? "#111" : danger ? "#fef2f2" : "#fff", color: primary ? "#fff" : danger ? "#b91c1c" : "#111", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, display:"inline-flex", alignItems:"center", gap:6, ...style }}>
      {children}
    </button>
  );
}

function Modal({ title, onClose, children, footer }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:50, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:14, width:"100%", maxWidth:600, maxHeight:"90vh", overflowY:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.15)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"18px 20px 14px", borderBottom:"1px solid #f0f0f0" }}>
          <span style={{ fontWeight:600, fontSize:15 }}>{title}</span>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:"#aaa", lineHeight:1 }}>x</button>
        </div>
        <div style={{ padding:"16px 20px" }}>{children}</div>
        {footer && <div style={{ padding:"12px 20px 16px", borderTop:"1px solid #f0f0f0", display:"flex", justifyContent:"flex-end", gap:8 }}>{footer}</div>}
      </div>
    </div>
  );
}

// In-app popup that geocodes a trip's full journey (via /api/geocode → OSM
// Nominatim) — each stop's pickup/origin (storage, warehouse, or the job's pickup)
// and its delivery — and draws the route legs in order on the US map.
const PICKUP_COLOR = "#1A8A4E", DELIVERY_COLOR = "#111";
function TripRouteModal({ title, waypoints, googleLink, onClose }) {
  const [pts, setPts] = useState(null);   // resolved waypoints, or null while geocoding
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = [];
        for (const w of waypoints) {
          let resolved = { ...w, failed: true };
          // Try candidates from most to least specific; stop at the first hit.
          for (let i = 0; i < w.candidates.length; i++) {
            try {
              const r = await fetch("/api/geocode?q=" + encodeURIComponent(w.candidates[i]));
              if (r.ok) {
                const d = await r.json();
                if (d && d.lat != null && d.lng != null) {
                  resolved = { ...w, lat: Number(d.lat), lng: Number(d.lng), resolvedLabel: d.label, approx: i > 0 };
                  break;
                }
              }
            } catch { /* try next candidate */ }
            if (cancelled) return;
          }
          if (cancelled) return;
          out.push(resolved);
          setPts([...out]);   // progressive reveal as each waypoint resolves
        }
      } catch (e) {
        if (!cancelled) setErr(e?.message || "Error geolocating stops");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const done = pts != null && pts.length === waypoints.length;
  // Sequential route number for each locatable waypoint (shared by map + list).
  let n = 0;
  const rows = (pts || []).map(p => { const ok = p.lat != null && p.lng != null; return { ...p, num: ok ? ++n : null }; });
  const located = rows.filter(r => r.num != null);
  const footer = (
    <>
      {googleLink && <a href={googleLink} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn>Open in Google Maps</Btn></a>}
      <Btn primary onClick={onClose}>Close</Btn>
    </>
  );
  const originText = (p) => p.type === "pickup" ? `Pickup${p.sourceLabel && p.sourceLabel !== "Pickup" ? " · " + p.sourceLabel : ""}` : "Delivery";

  return (
    <Modal title={`Route · ${title}`} onClose={onClose} footer={footer}>
      {err ? (
        <div style={{ padding:"20px", textAlign:"center", color:"#A32D2D", fontSize:13 }}>{err}</div>
      ) : (
        <>
          <div style={{ position:"relative", background:"#eaf3fb", border:"1px solid #efefef", borderRadius:12, overflow:"hidden", marginBottom:8 }}>
            <ComposableMap projection="geoAlbersUsa" projectionConfig={{ scale: 1000 }} width={800} height={500} style={{ width:"100%", height:"auto" }}>
              <Geographies geography={US_GEO_URL}>
                {({ geographies }) => geographies.map(geo => (
                  <Geography key={geo.rsmKey} geography={geo} style={{
                    default: { fill:"#f3f6e9", stroke:"#cdd8e3", strokeWidth:0.6, outline:"none" },
                    hover:   { fill:"#f3f6e9", stroke:"#cdd8e3", strokeWidth:0.6, outline:"none" },
                    pressed: { fill:"#f3f6e9", stroke:"#cdd8e3", strokeWidth:0.6, outline:"none" },
                  }} />
                ))}
              </Geographies>
              {/* route legs, in journey order — dashed when heading to a pickup (loading), solid when delivering */}
              {located.slice(1).map((p, i) => (
                <Line key={"leg" + i} from={[located[i].lng, located[i].lat]} to={[p.lng, p.lat]}
                  stroke="#185FA5" strokeWidth={2} strokeLinecap="round" strokeDasharray={p.type === "pickup" ? "4 4" : undefined} fill="none" />
              ))}
              {/* numbered waypoint markers, colored by type */}
              {located.map((p, i) => (
                <Marker key={"mk" + i} coordinates={[p.lng, p.lat]}>
                  <g>
                    <circle r={9} fill={p.type === "pickup" ? PICKUP_COLOR : DELIVERY_COLOR} stroke="#fff" strokeWidth={1.6} />
                    <text textAnchor="middle" y={3} style={{ fontSize:9, fontWeight:800, fill:"#fff" }}>{p.num}</text>
                  </g>
                </Marker>
              ))}
            </ComposableMap>
          </div>
          <div style={{ display:"flex", gap:14, flexWrap:"wrap", fontSize:11, color:"#666", marginBottom:10 }}>
            <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:"50%", background:PICKUP_COLOR }} />Pickup / loaded from</span>
            <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:"50%", background:DELIVERY_COLOR }} />Delivery</span>
          </div>
          {!done && <div style={{ fontSize:12, color:"#888", marginBottom:8 }}>Geolocating stops… ({(pts || []).length}/{waypoints.length})</div>}
          <div style={{ border:"1px solid #f0f0f0", borderRadius:8, overflow:"hidden" }}>
            {rows.map((p, i) => (
              <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"8px 10px", borderBottom:"1px solid #f4f4f4", fontSize:12.5 }}>
                <span style={{ width:20, height:20, borderRadius:"50%", background: p.num == null ? "#ccc" : (p.type === "pickup" ? PICKUP_COLOR : DELIVERY_COLOR), color:"#fff", fontSize:10, fontWeight:700, display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:1 }}>{p.num ?? "–"}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div>
                    <span style={{ fontSize:10.5, fontWeight:700, color: p.type === "pickup" ? "#1A6E3E" : "#333", textTransform:"uppercase", letterSpacing:"0.03em" }}>{originText(p)}</span>
                    <span style={{ color:"#bbb" }}> · </span>
                    <b style={{ fontFamily:"monospace" }}>{p.jobNumber}</b>{p.customer ? ` · ${p.customer}` : ""}
                    {p.approx && p.num != null && <span style={{ fontSize:10.5, fontWeight:600, color:"#854F0B", background:"#FAEEDA", borderRadius:20, padding:"1px 7px", marginLeft:6 }}>approx.</span>}
                  </div>
                  <div style={{ color: p.num == null ? "#A32D2D" : "#888", marginTop:1 }}>{p.num == null ? (p.candidates.length ? `Couldn't locate: ${p.query}` : (p.type === "pickup" ? "No pickup location on file" : "No delivery address on file")) : (p.resolvedLabel || p.query)}</div>
                </div>
              </div>
            ))}
          </div>
          {done && located.length < 2 && <div style={{ fontSize:12, color:"#A32D2D", marginTop:8 }}>Need at least 2 located points to draw a route.</div>}
        </>
      )}
    </Modal>
  );
}

function parsePastedMessages(text) {
  const blocks = text.split(/\n(?=Storage para:|storage para:)/i).filter(b => b.trim());
  if (!blocks.length) blocks.push(text);
  return blocks.map(block => {
    const get = (patterns) => { for (const p of patterns) { const m = block.match(p); if (m) return (m[1] || "").trim(); } return ""; };
    const driver = get([/storage para:\s*(.+)/i]);
    const brand = get([/^([A-Z][^\n]+(?:storage|store|smart|space|life|extra|haul)[^\n]*)/im]);
    const unit = get([/unit\s*(?:number|#)?[:\s]+([^\n]+)/i]);
    const address = get([/address[:\s]+([^\n]+)/i]);
    const state = (address.match(/,\s*([A-Z]{2})\s*\d{5}/) || [])[1] || "";
    const size = get([/size[:\s]+([^\n]+)/i]);
    const gate_code = get([/gate\s*code[:\s]+([^\n/]+)/i]);
    const lock = get([/use\s+([^\n]+?)\s+to\s+unlock/i]);
    const email = get([/email[:\s]+([^\n]+)/i]);
    const account = get([/account\s*#?[:\s]+([^\n]+)/i]);
    const rawDate = get([/date[:\s]+([^\n]+)/i]);
    let date_opened = "";
    if (rawDate) { const p = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (p) { const y = p[3].length === 2 ? "20" + p[3] : p[3]; date_opened = `${y}-${p[1].padStart(2,"0")}-${p[2].padStart(2,"0")}`; } }
    const jobLine = get([/jobs?[:\s]+(.+)/i]);
    const job_number = (jobLine.match(/([A-Z]{1,2}\d{6,})/i) || [])[1] || "";
    const notes = jobLine.replace(job_number, "").trim() || null;
    return { customer:null, driver, brand:brand||null, state, address:address||null, unit:unit||null, size:size||null, gate_code:gate_code||null, lock:lock||null, email:email||null, account:account||null, situation:"Open", monthly_cost:null, card_on_file:null, date_opened:date_opened||null, job_number:job_number||null, notes };
  }).filter(r => r.driver || r.unit || r.address);
}

function parseWhatsAppExport(rawText) {
  rawText = rawText.replace(/\u200e/g, "").replace(/\r/g, "");
  const lineRe = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s?[ap]?\.?m?\.?)\]?\s*-?\s*([^:]{1,60}?):\s*([\s\S]*)$/i;
  const lines = rawText.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (m) { if (current) entries.push(current); current = { date: m[1], sender: m[3].trim(), text: m[4] }; }
    else if (current) current.text += "\n" + line;
  }
  if (current) entries.push(current);
  const blocks = [];
  let block = null;
  const isNoise = t => /omitted|encrypted|created group|added you|changed the subject|security code|end-to-end/i.test(t);
  for (const e of entries) {
    if (isNoise(e.text)) continue;
    if (!block || block.sender !== e.sender) { if (block) blocks.push(block); block = { sender: e.sender, date: e.date, lines: [e.text] }; }
    else block.lines.push(e.text);
  }
  if (block) blocks.push(block);
  return blocks.filter(b => /storage|unit|gate code|address/i.test(b.lines.join("\n")))
    .map(b => parsePastedMessages(b.lines.join("\n"))[0] || null).filter(Boolean);
}


// Card shell shared by the login / set-password / deactivated screens.
function AuthCard({ children }) {
  return (
    <div style={{ minHeight:"100vh", background:"#fafafa", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ background:"#fff", borderRadius:16, border:"1px solid #efefef", padding:"36px 32px", width:"100%", maxWidth:380, boxShadow:"0 4px 24px rgba(0,0,0,0.06)" }}>
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:11, fontWeight:600, color:"#aaa", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:4 }}>No Borders Moving and Storage</div>
          <h1 style={{ fontSize:22, fontWeight:700, margin:0, letterSpacing:"-0.02em" }}>Storage Manager</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

const authInp = { fontSize:14, padding:"10px 14px", borderRadius:8, border:"1px solid #e5e5e5", width:"100%", outline:"none", marginBottom:10, boxSizing:"border-box" };
const authBtn = (loading) => ({ width:"100%", padding:"11px", borderRadius:8, border:"none", background:"#111", color:"#fff", fontSize:14, fontWeight:600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1, marginBottom:14 });

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [forgot, setForgot] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    setLoading(true); setError(null); setMessage(null);
    if (forgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/?reset=1",
      });
      if (error) setError(error.message);
      else setMessage("If that email exists, a reset link is on its way.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError("Incorrect email or password.");
    }
    setLoading(false);
  }

  return (
    <AuthCard>
      <p style={{ fontSize:13, color:"#888", margin:"-16px 0 18px" }}>{forgot ? "Reset your password" : "Sign in to continue"}</p>
      {error && <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#b91c1c", marginBottom:12 }}>{error}</div>}
      {message && <div style={{ background:"#f0fdf4", border:"1px solid #86efac", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#166534", marginBottom:12 }}>{message}</div>}
      <input style={authInp} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSubmit()} />
      {!forgot && <input style={{ ...authInp, marginBottom:16 }} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSubmit()} />}
      <button onClick={handleSubmit} disabled={loading || !email || (!forgot && !password)} style={authBtn(loading)}>
        {loading ? "Loading..." : forgot ? "Send reset link" : "Sign in"}
      </button>
      <p style={{ textAlign:"center", fontSize:13, color:"#888", margin:0 }}>
        <span onClick={() => { setForgot(!forgot); setError(null); setMessage(null); }} style={{ color:"#111", fontWeight:600, cursor:"pointer", textDecoration:"underline" }}>
          {forgot ? "Back to sign in" : "Forgot your password?"}
        </span>
      </p>
    </AuthCard>
  );
}

// Shown when a user arrives from an invite or password-reset email link.
function SetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function handleSubmit() {
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setLoading(true); setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) setError(error.message);
    else setDone(true);
  }

  if (done) return (
    <AuthCard>
      <div style={{ background:"#f0fdf4", border:"1px solid #86efac", borderRadius:8, padding:"12px", fontSize:13, color:"#166534", marginBottom:16 }}>Password set. You're all set to use the app.</div>
      <button onClick={onDone} style={authBtn(false)}>Continue</button>
    </AuthCard>
  );

  return (
    <AuthCard>
      <p style={{ fontSize:13, color:"#888", margin:"-16px 0 18px" }}>Set your password</p>
      {error && <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#b91c1c", marginBottom:12 }}>{error}</div>}
      <input style={authInp} type="password" placeholder="New password" value={password} onChange={e => setPassword(e.target.value)} />
      <input style={{ ...authInp, marginBottom:16 }} type="password" placeholder="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSubmit()} />
      <button onClick={handleSubmit} disabled={loading || !password || !confirm} style={authBtn(loading)}>
        {loading ? "Saving..." : "Set password"}
      </button>
    </AuthCard>
  );
}

// Shown when the signed-in account is deactivated or has no sections granted.
function DeactivatedScreen({ onSignOut, message }) {
  return (
    <AuthCard>
      <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, padding:"12px", fontSize:13, color:"#b91c1c", marginBottom:16 }}>
        {message || "Your account doesn't have access yet. Contact an administrator."}
      </div>
      <button onClick={onSignOut} style={authBtn(false)}>Sign out</button>
    </AuthCard>
  );
}

const jobBadgeStyle = (delivered) => ({
  display:"inline-flex", alignItems:"center", gap:5, fontSize:10, fontWeight:600,
  padding:"2px 8px", borderRadius:20, flexShrink:0,
  background: delivered ? "#f1f1f1" : "#EAF3DE",
  color: delivered ? "#888" : "#3B6D11",
});

function JobCard({ job, onDeliver }) {
  const delivered = !!job.date_out;
  return (
    <div style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", background: delivered ? "#fafafa" : "#fff" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom: (job.customer||job.driver||job.notes) ? 6 : 0 }}>
        <span style={jobBadgeStyle(delivered)}>
          <span style={{ width:6, height:6, borderRadius:"50%", background: delivered ? "#bbb" : "#639922" }} />
          {delivered ? "Delivered" : "Active"}
        </span>
        <span style={{ fontFamily:"monospace", fontSize:12, fontWeight:600 }}>{job.job_number || "—"}</span>
        <span style={{ flex:1 }} />
        {!delivered && (
          <Btn onClick={() => onDeliver(job)} style={{ padding:"4px 10px", fontSize:12 }}>Mark delivered</Btn>
        )}
      </div>
      <div style={{ fontSize:12, color:"#666", display:"flex", flexWrap:"wrap", gap:"2px 12px" }}>
        {job.customer && <span>Client: <strong style={{ color:"#333" }}>{job.customer}</strong></span>}
        {job.driver && <span>Driver: <strong style={{ color:"#333" }}>{job.driver}</strong></span>}
        {job.date_in && <span>In: {job.date_in}</span>}
        {job.date_out && <span>Out: {job.date_out}</span>}
      </div>
      {job.notes && <div style={{ fontSize:12, color:"#888", marginTop:4 }}>{job.notes}</div>}
    </div>
  );
}

function JobHistory({ storageId, jobs, allJobs = [], userEmail, dbReady, onSetup, onChange }) {
  const EMPTY = { job_number:"", customer:"", driver:"", date_in:"", notes:"" };
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [showDelivered, setShowDelivered] = useState(false);
  const [mode, setMode] = useState("existing"); // existing | new
  const [pickKey, setPickKey] = useState("");

  const active = jobs.filter(j => !j.date_out);
  const delivered = jobs.filter(j => j.date_out);

  // Active jobs not already in this unit — pick one to attach without retyping.
  const candidates = useMemo(() => {
    const groups = new Map();
    for (const j of allJobs) {
      if (j.date_out) continue;
      const k = jobKey(j);
      if (!groups.has(k)) groups.set(k, { key:k, job_number:j.job_number, customer:j.customer, date_in:j.date_in, here:false });
      if (String(j.storage_id) === String(storageId)) groups.get(k).here = true;
    }
    return [...groups.values()].filter(g => !g.here).sort((a, b) => (b.date_in || "").localeCompare(a.date_in || ""));
  }, [allJobs, storageId]);

  // Attach an already-existing job to this unit by cloning a template part.
  async function addExistingJob() {
    const parts = allJobs.filter(j => jobKey(j) === pickKey);
    if (!parts.length) return;
    if (parts.some(p => String(p.storage_id) === String(storageId))) { setErr("That job is already in this unit."); return; }
    setSaving(true); setErr(null);
    const tmpl = parts[0];
    const { id, storage_id, warehouse, created_at, updated_at, date_out, ...rest } = tmpl;
    const row = { ...rest, storage_id: storageId, warehouse: null, date_out: null, created_by: userEmail || null };
    const { error } = await supabase.from("storage_jobs").insert([row]);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setPickKey("");
    onChange && onChange();
  }

  async function addJob() {
    if (!form.job_number && !form.customer && !form.driver) { setErr("Fill in at least job, client or driver."); return; }
    setSaving(true); setErr(null);
    const payload = {
      storage_id: storageId,
      job_number: form.job_number || null,
      customer: form.customer || null,
      driver: form.driver || null,
      date_in: form.date_in || today(),
      notes: form.notes || null,
    };
    const { error } = await supabase.from("storage_jobs").insert([payload]);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setForm(EMPTY);
    onChange && onChange();
  }

  async function deliver(job) {
    const { error } = await supabase.from("storage_jobs").update({ date_out: today() }).eq("id", job.id);
    if (error) { setErr(error.message); return; }
    onChange && onChange();
  }

  if (!dbReady) {
    return (
      <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"12px 14px", fontSize:13, color:"#854F0B" }}>
        The job history needs an initial database setup.
        {onSetup && <button onClick={onSetup} style={{ marginLeft:8, background:"none", border:"none", color:"#854F0B", fontWeight:600, textDecoration:"underline", cursor:"pointer", fontSize:13 }}>See how to enable it</button>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:14 }}>
        {active.length === 0 && delivered.length === 0 && (
          <div style={{ fontSize:13, color:"#bbb", padding:"6px 0" }}>No jobs in this unit yet.</div>
        )}
        {active.map(j => <JobCard key={j.id} job={j} onDeliver={deliver} />)}

        {delivered.length > 0 && (
          <div>
            <button onClick={() => setShowDelivered(s => !s)}
              style={{ background:"none", border:"none", cursor:"pointer", color:"#888", fontSize:12, fontWeight:600, padding:"4px 0", display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ display:"inline-block", transform: showDelivered ? "rotate(90deg)" : "none", transition:"transform .15s" }}>▸</span>
              {delivered.length} entregado{delivered.length === 1 ? "" : "s"}
            </button>
            {showDelivered && (
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:8 }}>
                {delivered.map(j => <JobCard key={j.id} job={j} onDeliver={deliver} />)}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ background:"#fafafa", border:"1px solid #f0f0f0", borderRadius:10, padding:"12px" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:10 }}>
          <span style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>Add job</span>
          <div style={{ display:"inline-flex", background:"#fff", border:"1px solid #e5e5e5", borderRadius:8, padding:2 }}>
            {[["existing","Existente"],["new","Create new"]].map(([m,l]) => (
              <button key={m} onClick={() => { setMode(m); setErr(null); }} type="button"
                style={{ fontSize:12, fontWeight: mode===m?600:500, padding:"4px 10px", borderRadius:6, border:"none", cursor:"pointer", background: mode===m?"#111":"transparent", color: mode===m?"#fff":"#666" }}>{l}</button>
            ))}
          </div>
        </div>
        {mode === "existing" ? (
          <>
            <Field label="Job existente">
              <select style={inp} value={pickKey} onChange={e => { setPickKey(e.target.value); setErr(null); }}>
                <option value="">— Select job —</option>
                {candidates.map(g => <option key={g.key} value={g.key}>{[g.job_number || "(no #)", g.customer].filter(Boolean).join(" — ")}</option>)}
              </select>
            </Field>
            {candidates.length === 0 && <div style={{ fontSize:12, color:"#999", marginTop:6 }}>No other active jobs available. Use "Create new".</div>}
            {err && <div style={{ fontSize:12, color:"#b91c1c", marginTop:8 }}>{err}</div>}
            <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
              <Btn primary disabled={saving || !pickKey} onClick={addExistingJob}>{saving ? "Adding..." : "+ Add to this unit"}</Btn>
            </div>
          </>
        ) : (
          <>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <Field label="Job #"><input style={inp} value={form.job_number} onChange={e => setForm(f => ({...f, job_number:e.target.value}))} placeholder="B8417142" /></Field>
              <Field label="Date in"><input style={inp} type="date" value={form.date_in} onChange={e => setForm(f => ({...f, date_in:e.target.value}))} /></Field>
              <Field label="Client"><input style={inp} value={form.customer} onChange={e => setForm(f => ({...f, customer:e.target.value}))} placeholder="Client name" /></Field>
              <Field label="Driver"><input style={inp} value={form.driver} onChange={e => setForm(f => ({...f, driver:e.target.value}))} placeholder="Driver" /></Field>
              <Field label="Notes" full><input style={inp} value={form.notes} onChange={e => setForm(f => ({...f, notes:e.target.value}))} placeholder="Job notes" /></Field>
            </div>
            {err && <div style={{ fontSize:12, color:"#b91c1c", marginTop:8 }}>{err}</div>}
            <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
              <Btn primary disabled={saving} onClick={addJob}>{saving ? "Adding..." : "+ Add job"}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Left navigation for the Operations CRM.
const NAV = [
  { section:"Operations", items:[
    { id:"dispatching", label:"Dispatching", icon:"🚚" },
    { id:"calendario", label:"Pickup Calendar", icon:"📅" },
    { id:"calendario_entregas", label:"Delivery Calendar", icon:"📦" },
    { id:"storage", label:"Storage", icon:"🏬" },
    { id:"jobs", label:"Jobs", icon:"💼" },
    { id:"messages", label:"Chats", icon:"💬" },
  ]},
  { section:"Finanzas", items:[
    { id:"brokers", label:"Brokers", icon:"🏦" },
    { id:"billing", label:"Storage Billing", icon:"🧾" },
    { id:"settlements", label:"Settlements", icon:"📑" },
    { id:"extras", label:"Extras", icon:"➕" },
    { id:"payments", label:"Payments", icon:"💰" },
    { id:"clientes", label:"Clients", icon:"👥" },
  ]},
  { section:"Fleet", items:[
    { id:"drivers", label:"Drivers", icon:"🪪" },
    { id:"trucks", label:"Trucks", icon:"🚛" },
    { id:"trips", label:"Trips / Live Load", icon:"🛣️" },
    { id:"equipment", label:"Equipment", icon:"🧰" },
  ]},
  { section:"Business", items:[
    { id:"compliance", label:"Legal & Compliance", icon:"📋" },
    { id:"analytics", label:"Analytics", icon:"📊" },
    { id:"suggestions", label:"Suggestions", icon:"💡" },
    { id:"bol", label:"BOL", icon:"📄" },
    { id:"users", label:"Users", icon:"👤" },
    { id:"settings", label:"Settings", icon:"⚙️" },
  ]},
];

// Flat list of every CRM section id (drives the permissions grid + page fallback).
const SECTION_IDS = NAV.flatMap(g => g.items.map(it => it.id));
function Sidebar({ page, setPage, onSignOut, badges = {}, can = () => true, isAdmin = false }) {
  // Only show sections the user can view; the Users section is admin-only.
  const visibleNav = NAV
    .map(group => ({ ...group, items: group.items.filter(it => it.id === "users" ? isAdmin : it.id === "suggestions" ? true : can(it.id, "view")) }))
    .filter(group => group.items.length > 0);
  return (
    <div style={{ width:220, flexShrink:0, background:"#fff", borderRight:"1px solid #efefef", display:"flex", flexDirection:"column", height:"100vh", position:"sticky", top:0, alignSelf:"flex-start" }}>
      <div style={{ padding:"18px 18px 14px", borderBottom:"1px solid #f3f3f3" }}>
        <div style={{ fontSize:15, fontWeight:700, letterSpacing:"-0.01em", lineHeight:1.2 }}>No Borders Moving</div>
        <div style={{ fontSize:10, color:"#aaa", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", marginTop:3 }}>Operations CRM</div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"10px" }}>
        {visibleNav.map(group => (
          <div key={group.section} style={{ marginBottom:12 }}>
            <div style={{ fontSize:10, fontWeight:600, color:"#bbb", textTransform:"uppercase", letterSpacing:"0.07em", padding:"6px 10px 4px" }}>{group.section}</div>
            {group.items.map(it => {
              const active = page === it.id;
              const badge = badges[it.id] || 0;
              return (
                <button key={it.id} onClick={() => setPage(it.id)}
                  style={{ width:"100%", display:"flex", alignItems:"center", gap:9, padding:"8px 10px", borderRadius:8, border:"none", cursor:"pointer", fontSize:13.5, fontWeight: active?600:500, textAlign:"left", marginBottom:2, background: active?"#111":"transparent", color: active?"#fff":"#444" }}>
                  <span style={{ fontSize:14 }}>{it.icon}</span>
                  <span style={{ flex:1 }}>{it.label}</span>
                  {badge > 0 && (
                    <span style={{ background: active?"#fff":"#E24B4A", color: active?"#111":"#fff", fontSize:10, fontWeight:700, borderRadius:10, padding:"1px 6px" }}>{badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ padding:"12px", borderTop:"1px solid #f3f3f3" }}>
        <button onClick={onSignOut} style={{ width:"100%", padding:"8px", borderRadius:8, border:"1px solid #eee", background:"#fff", color:"#888", fontSize:12, cursor:"pointer" }}>Sign out</button>
      </div>
    </div>
  );
}

const PAGE_META = {
  dispatching: { title:"Dispatching", sub:"Pickup & delivery dispatch" },
  calendario:  { title:"Pickup Calendar", sub:"Pick ups programados" },
  calendario_entregas: { title:"Delivery Calendar", sub:"Scheduled deliveries" },
  storage:     { title:"Storage", sub:"Physical units and occupancy" },
  jobs:        { title:"Jobs", sub:"All jobs with full detail" },
  messages:    { title:"Chats", sub:"Team conversations and direct messages" },
  brokers:     { title:"Brokers", sub:"Brokers and outstanding balances" },
  billing:     { title:"Storage Billing", sub:"Monthly storage billing for clients" },
  settlements: { title:"Carrier Settlements", sub:"Broker-delivery closing sheets" },
  extras:      { title:"Extras & Commissions", sub:"Extras per job and driver/rep commissions" },
  payments:    { title:"Payments", sub:"Collections, cash in circulation and deposits" },
  clientes:    { title:"Clients", sub:"Clients and their jobs" },
  drivers:     { title:"Drivers", sub:"Operation drivers" },
  trucks:      { title:"Trucks", sub:"Truck fleet" },
  trips:       { title:"Trips / Live Load", sub:"Live load per truck" },
  equipment:   { title:"Equipment", sub:"Internal equipment & materials per location" },
  compliance:  { title:"Legal & Compliance", sub:"Companies, documents and expirations" },
  analytics:   { title:"Analytics", sub:"AI metrics and recommendations" },
  suggestions: { title:"Suggestions", sub:"Employee feedback and improvement ideas" },
  users:       { title:"Users", sub:"Team members, roles and permissions" },
  bol:         { title:"BOL", sub:"Bill of Lading templates and generation" },
  settings:    { title:"Settings", sub:"Operation settings" },
};

// Sections that carry per-section permissions (everything except the admin-only
// Users section and Suggestions, which is open to every employee by design).
const PERMISSION_SECTIONS = NAV.flatMap(g => g.items).filter(it => it.id !== "users" && it.id !== "suggestions");
const PERM_LEVELS = ["view", "edit", "create"];
const EMPTY_PERMS = () => Object.fromEntries(PERMISSION_SECTIONS.map(s => [s.id, { view:false, edit:false, create:false }]));

// Admin-only section: list users, invite new ones (email + per-section permissions),
// edit roles/permissions, activate/deactivate, and send password-reset emails.
function UsersSection({ session }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [warn, setWarn] = useState(null); // non-fatal: the admin service is down but the RLS fallback works
  const [modal, setModal] = useState(null); // null | { mode, id, email, full_name, role, permissions, active }
  const [busy, setBusy] = useState(false);

  const api = useCallback(async (action, payload) => {
    const res = await fetch("/api/admin-users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
      body: JSON.stringify({ action, payload }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.error || `Error ${res.status}`;
      throw new Error(json.detail ? `${msg} (${json.detail})` : msg);
    }
    return json;
  }, [session]);

  // Read every profile straight through the RLS-protected client. The
  // profiles_select policy lets an admin (is_admin(), SECURITY DEFINER) read all
  // rows, so the list works without the serverless function — which only the
  // invite flow strictly needs (creating a login needs the service role).
  const listProfiles = useCallback(async () => {
    const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }, []);

  // Self-lockout guard, mirrored from the server, for direct profile writes.
  const writeProfile = useCallback(async (id, patch) => {
    if (id === session.user.id && (patch.role === "member" || patch.active === false))
      throw new Error("You can't remove your own admin access.");
    const { error } = await supabase.from("profiles").update(patch).eq("id", id);
    if (error) throw error;
  }, [session]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // Prefer the admin API: it returns the profiles plus each user's last_login
      // (auth.users.last_sign_in_at), which the RLS profiles query can't expose.
      // Fall back to the direct RLS query if the function is unavailable (then
      // last_login is simply absent).
      let list;
      try { const r = await api("list"); list = r.users || []; setWarn(null); }
      catch (e1) {
        list = await listProfiles();
        // Surface the outage instead of failing silently (it also explains why
        // Last login shows "—"): invites won't work until the service is fixed.
        setWarn(`Admin service unavailable: ${e1.message}. User list loaded in read-only fallback mode (no last login, invites will fail). Open /api/admin-users in the browser for a config health check.`);
      }
      setUsers(list);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [listProfiles, api]);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    setModal({ mode:"new", email:"", full_name:"", role:"member", permissions: EMPTY_PERMS(), active:true });
  }
  function openEdit(u) {
    const permissions = EMPTY_PERMS();
    for (const s of PERMISSION_SECTIONS) {
      const p = u.permissions?.[s.id]; if (p) permissions[s.id] = { view:!!p.view, edit:!!p.edit, create:!!p.create };
    }
    setModal({ mode:"edit", id:u.id, email:u.email, full_name:u.full_name || "", role:u.role, permissions, active:u.active !== false });
  }

  function togglePerm(sectionId, level) {
    setModal(m => {
      const cur = m.permissions[sectionId];
      const next = { ...cur, [level]: !cur[level] };
      // Editing or creating implies being able to view the section.
      if ((level === "edit" || level === "create") && next[level]) next.view = true;
      if (level === "view" && !next.view) { next.edit = false; next.create = false; }
      return { ...m, permissions: { ...m.permissions, [sectionId]: next } };
    });
  }
  function setAll(value) {
    setModal(m => ({ ...m, permissions: Object.fromEntries(PERMISSION_SECTIONS.map(s => [s.id, { view:value, edit:value, create:value }])) }));
  }

  // Fallback invite that needs no server credentials: sign the person up with a
  // random throwaway password on a secondary client (so the admin's own session
  // is never replaced), let the on_auth_user_created trigger create the profile
  // row, attach role/permissions through the admin's RLS write access, and make
  // sure an email goes out so they can set their password.
  async function inviteFallback(email, full_name) {
    const tmp = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const password = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => alphabet[b % alphabet.length]).join("");
    const { data, error } = await tmp.auth.signUp({
      email, password,
      options: { emailRedirectTo: window.location.origin + "/?invited=1", data: { full_name } },
    });
    if (error) throw new Error(error.message);
    // With email confirmation on, an existing email comes back as a fake user
    // with no identities instead of an error — detect it so we don't mislead.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0)
      throw new Error(`${email} already has an account. Use Send reset instead.`);
    await writeProfile(data.user.id, { email, full_name, role: modal.role, permissions: modal.permissions, active: true });
    if (!data.session) {
      // Email confirmation is on → Supabase already sent the confirmation link;
      // opening it lands on /?invited=1 where they set their password.
      return `Invitation sent to ${email} (signup confirmation email).`;
    }
    // Confirmation off → no email was sent; send a set-your-password email.
    const { error: rErr } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/?invited=1" });
    if (rErr) return `Account for ${email} was created, but the email failed (${rErr.message}). Use Send reset from the list.`;
    return `Invitation sent to ${email} (set-password email).`;
  }

  async function save() {
    setBusy(true); setError(null); setNotice(null);
    try {
      if (modal.mode === "new") {
        const email = modal.email.trim(), full_name = modal.full_name.trim();
        // Preferred path: the serverless invite (needs the service role key).
        try {
          await api("invite", { email, full_name, role: modal.role, permissions: modal.permissions });
          setNotice(`Invitation sent to ${email}.`);
        } catch (e) {
          // Admin service down/misconfigured → create the login from the browser.
          try {
            setNotice(await inviteFallback(email, full_name));
          } catch (e2) {
            throw new Error(`Couldn't invite ${email}. Admin service: ${e.message}. Direct signup fallback: ${e2.message}`);
          }
        }
      } else {
        const patch = { full_name: modal.full_name.trim(), role: modal.role, permissions: modal.permissions, active: modal.active };
        // Try the API; fall back to a direct RLS-protected update if it's down.
        try { await api("update", { id: modal.id, ...patch }); }
        catch { await writeProfile(modal.id, patch); }
        setNotice("User updated.");
      }
      setModal(null);
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function toggleActive(u) {
    setBusy(true); setError(null); setNotice(null);
    const next = !(u.active !== false);
    try {
      try { await api("update", { id: u.id, active: next }); }
      catch { await writeProfile(u.id, { active: next }); }
      await load();
    }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function sendReset(u) {
    setError(null); setNotice(null);
    const { error } = await supabase.auth.resetPasswordForEmail(u.email, { redirectTo: window.location.origin + "/?reset=1" });
    if (error) setError(error.message); else setNotice(`Password reset email sent to ${u.email}.`);
  }

  async function removeUser(u) {
    if (!window.confirm(`Delete ${u.email}? This permanently removes the account.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try { await api("delete", { id: u.id }); setNotice("User deleted."); await load(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  const td = { padding:"10px 12px", fontSize:13, borderBottom:"1px solid #f3f3f3", textAlign:"left", verticalAlign:"middle" };
  const th = { ...td, fontSize:11, fontWeight:600, color:"#999", textTransform:"uppercase", letterSpacing:"0.05em" };

  function permSummary(u) {
    if (u.role === "admin") return "Full access (admin)";
    const ids = PERMISSION_SECTIONS.filter(s => u.permissions?.[s.id]?.view).map(s => s.label);
    return ids.length ? ids.join(", ") : "No access";
  }

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
        <Btn primary onClick={openNew}>+ New user</Btn>
      </div>
      {error && <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#b91c1c", marginBottom:12 }}>{error}</div>}
      {warn && <div style={{ background:"#fffbeb", border:"1px solid #fcd34d", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#92400e", marginBottom:12 }}>{warn}</div>}
      {notice && <div style={{ background:"#f0fdf4", border:"1px solid #86efac", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#166534", marginBottom:12 }}>{notice}</div>}

      <div style={{ background:"#fff", border:"1px solid #efefef", borderRadius:12, overflow:"hidden" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead><tr>
            <th style={th}>Email</th><th style={th}>Name</th><th style={th}>Role</th><th style={th}>Access</th><th style={th}>Last login</th><th style={th}>Status</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {loading ? (
              <tr><td style={td} colSpan={7}>Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td style={td} colSpan={7}>No users yet.</td></tr>
            ) : users.map(u => (
              <tr key={u.id}>
                <td style={td}>{u.email}</td>
                <td style={td}>{u.full_name || "—"}</td>
                <td style={td}>
                  <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background: u.role==="admin" ? "#EAF3DE" : "#f1f1f1", color: u.role==="admin" ? "#3B6D11" : "#888" }}>{u.role}</span>
                </td>
                <td style={{ ...td, color:"#888", maxWidth:280 }}>{permSummary(u)}</td>
                <td style={{ ...td, color:"#888", whiteSpace:"nowrap" }}>{fmtTs(u.last_login) || "—"}</td>
                <td style={td}>{u.active !== false ? <span style={{ color:"#3B6D11" }}>Active</span> : <span style={{ color:"#b91c1c" }}>Inactive</span>}</td>
                <td style={{ ...td, whiteSpace:"nowrap", textAlign:"right" }}>
                  <button onClick={() => openEdit(u)} style={{ marginRight:6, padding:"5px 10px", borderRadius:7, border:"1px solid #eee", background:"#fff", cursor:"pointer", fontSize:12 }}>Edit</button>
                  <button onClick={() => sendReset(u)} style={{ marginRight:6, padding:"5px 10px", borderRadius:7, border:"1px solid #eee", background:"#fff", cursor:"pointer", fontSize:12 }}>Send reset</button>
                  <button onClick={() => toggleActive(u)} disabled={busy} style={{ padding:"5px 10px", borderRadius:7, border:"1px solid #eee", background:"#fff", cursor:"pointer", fontSize:12, color: u.active !== false ? "#b91c1c" : "#3B6D11" }}>{u.active !== false ? "Deactivate" : "Activate"}</button>
                  {u.active === false && (
                    <button onClick={() => removeUser(u)} disabled={busy} style={{ marginLeft:6, padding:"5px 10px", borderRadius:7, border:"1px solid #f1c4c4", background:"#fff", cursor:"pointer", fontSize:12, color:"#b91c1c" }}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }} onClick={() => !busy && setModal(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#fff", borderRadius:14, width:"100%", maxWidth:560, maxHeight:"90vh", overflowY:"auto", padding:24 }}>
            <h2 style={{ fontSize:18, fontWeight:700, margin:"0 0 16px" }}>{modal.mode === "new" ? "Invite new user" : "Edit user"}</h2>
            <label style={{ fontSize:12, fontWeight:600, color:"#888" }}>Email</label>
            <input style={{ ...authInp, marginTop:4 }} type="email" value={modal.email} disabled={modal.mode === "edit"} onChange={e => setModal(m => ({ ...m, email: e.target.value }))} placeholder="user@example.com" />
            <label style={{ fontSize:12, fontWeight:600, color:"#888" }}>Full name</label>
            <input style={{ ...authInp, marginTop:4 }} value={modal.full_name} onChange={e => setModal(m => ({ ...m, full_name: e.target.value }))} placeholder="Optional" />
            <label style={{ fontSize:12, fontWeight:600, color:"#888" }}>Role</label>
            <select style={{ ...authInp, marginTop:4 }} value={modal.role} onChange={e => setModal(m => ({ ...m, role: e.target.value }))}>
              <option value="member">Member</option>
              <option value="admin">Admin (full access)</option>
            </select>

            {modal.role === "admin" ? (
              <div style={{ background:"#EAF3DE", border:"1px solid #cfe3b6", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#3B6D11", margin:"6px 0 12px" }}>
                Admins have full access to every section, including user management.
              </div>
            ) : (
              <>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", margin:"14px 0 6px" }}>
                  <label style={{ fontSize:12, fontWeight:600, color:"#888" }}>Permissions per section</label>
                  <div style={{ display:"flex", gap:6 }}>
                    <button onClick={() => setAll(true)} style={{ padding:"3px 8px", borderRadius:6, border:"1px solid #eee", background:"#fff", cursor:"pointer", fontSize:11 }}>Select all</button>
                    <button onClick={() => setAll(false)} style={{ padding:"3px 8px", borderRadius:6, border:"1px solid #eee", background:"#fff", cursor:"pointer", fontSize:11 }}>Clear</button>
                  </div>
                </div>
                <table style={{ width:"100%", borderCollapse:"collapse" }}>
                  <thead><tr>
                    <th style={{ ...th, padding:"6px 8px" }}>Section</th>
                    {PERM_LEVELS.map(l => <th key={l} style={{ ...th, padding:"6px 8px", textAlign:"center", width:64 }}>{l}</th>)}
                  </tr></thead>
                  <tbody>
                    {PERMISSION_SECTIONS.map(s => (
                      <tr key={s.id}>
                        <td style={{ ...td, padding:"6px 8px" }}>{s.icon} {s.label}</td>
                        {PERM_LEVELS.map(l => (
                          <td key={l} style={{ ...td, padding:"6px 8px", textAlign:"center" }}>
                            <input type="checkbox" checked={!!modal.permissions[s.id][l]} onChange={() => togglePerm(s.id, l)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:18 }}>
              <button onClick={() => setModal(null)} disabled={busy} style={{ padding:"9px 16px", borderRadius:8, border:"1px solid #eee", background:"#fff", cursor:"pointer", fontSize:13 }}>Cancel</button>
              <Btn primary disabled={busy || !modal.email} onClick={save}>{busy ? "Saving…" : modal.mode === "new" ? "Send invitation" : "Save changes"}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(undefined); // undefined=loading, null=none, obj=loaded
  const [nameInput, setNameInput] = useState("");    // editable name in Settings
  const [savingName, setSavingName] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState(null);
  const [pwForm, setPwForm] = useState({ current:"", next:"", confirm:"" }); // change-password form in Settings
  const [pwSaving, setPwSaving] = useState(false);
  const [pwNotice, setPwNotice] = useState(null); // { ok, text }
  const [pwRecovery, setPwRecovery] = useState(false); // invite / reset-password landing
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [liveIndicator, setLiveIndicator] = useState(false);
  const [page, setPage] = useState("dispatching");   // sidebar navigation
  const [chatUnread, setChatUnread] = useState(0);   // unread team-chat messages (sidebar badge)
  const [onlineIds, setOnlineIds] = useState([]);    // user ids currently online (Realtime Presence)
  const [bolJobNumber, setBolJobNumber] = useState(null); // job to pre-select in the BOL generator
  const [lang, setLang] = useState(() => { try { return localStorage.getItem("lang") || "en"; } catch { return "en"; } });
  const [showDupModal, setShowDupModal] = useState(false);  // duplicates review modal
  const [dupFocus, setDupFocus] = useState(null);           // null = all; "jobs" | "payments" | "storages" scopes the modal to one section
  const [dismissedDups, setDismissedDups] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem("dismissedDups") || "[]")); } catch { return new Set(); } });
  const [tab, setTab] = useState("active");           // jobs page sub-tab: active/delivered/wh:*
  const [dispatchFilter, setDispatchFilter] = useState("all"); // all/pickups/deliveries/longhaul/nofadd
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [storageBannerDismissed, setStorageBannerDismissed] = useState(false);
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState("");
  const [sortBy, setSortBy] = useState("date-desc");
  const [listPage, setListPage] = useState(0);   // current page of the Storage Units / Jobs list
  const [detailId, setDetailId] = useState(null);
  const [jobDetailKey, setJobDetailKey] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showAddJob, setShowAddJob] = useState(false);
  const [jobForm, setJobForm] = useState(EMPTY_JOB);
  const [jobSaving, setJobSaving] = useState(false);
  const [jobErr, setJobErr] = useState(null);
  const [editingJobKey, setEditingJobKey] = useState(null);
  // Warehouse "+ Job" picker: choose an existing job to add here, or create a new one.
  const [whPicker, setWhPicker] = useState(null); // { name } | null
  const [whPickerKey, setWhPickerKey] = useState(""); // selected existing job key
  const [whPickerSaving, setWhPickerSaving] = useState(false);
  // Top-level "+ Job to unit" picker: choose a unit + an existing job (or create new).
  const [unitJobPicker, setUnitJobPicker] = useState(false);
  const [ujUnitId, setUjUnitId] = useState("");
  const [ujKey, setUjKey] = useState("");
  const [ujSaving, setUjSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importTab, setImportTab] = useState("paste");
  const [pasteText, setPasteText] = useState("");
  const [pending, setPending] = useState([]);
  const [excluded, setExcluded] = useState({});
  const [zipStatus, setZipStatus] = useState("");
  const [zipName, setZipName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [dbReady, setDbReady] = useState(false);
  const [dbSetupNeeded, setDbSetupNeeded] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
  const [paymentColMissing, setPaymentColMissing] = useState(false);
  const [driverColMissing, setDriverColMissing] = useState(false);
  const [faddColMissing, setFaddColMissing] = useState(false);
  const [jobColsMissing, setJobColsMissing] = useState(false);
  const [crmV2Missing, setCrmV2Missing] = useState(false);
  const [billingMissing, setBillingMissing] = useState(false);
  const [billingNotesMissing, setBillingNotesMissing] = useState(false);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [billing, setBilling] = useState([]);
  const [showBillingModal, setShowBillingModal] = useState(false);
  const [billingForm, setBillingForm] = useState(EMPTY_BILLING_FORM);
  const [billingJobSearch, setBillingJobSearch] = useState("");
  const [billingSaving, setBillingSaving] = useState(false);
  const [storageTab, setStorageTab] = useState("storage_units");  // storage_units | <warehouse name>
  const [unitsSubTab, setUnitsSubTab] = useState("units");        // units | unit_jobs (inside Storage Units)
  const [storageView, setStorageView] = useState("list");         // list | map (units sub-tab)
  const [mapStateFilter, setMapStateFilter] = useState("");       // 2-letter state selected on the map
  const [billingTab, setBillingTab] = useState("all");       // all | pending | overdue | paid
  const [capTarget, setCapTarget] = useState(null);          // { kind, id?, name?, value }
  const [brokers, setBrokers] = useState([]);
  const [showBrokerModal, setShowBrokerModal] = useState(false);
  const [brokerForm, setBrokerForm] = useState(EMPTY_BROKER);
  const [editingBrokerId, setEditingBrokerId] = useState(null);
  const [brokerSaving, setBrokerSaving] = useState(false);
  // CRM v3: drivers table, calendar, clientes
  const [crmV3Missing, setCrmV3Missing] = useState(false);
  const [calStatusMissing, setCalStatusMissing] = useState(false);
  const [driversList, setDriversList] = useState([]);
  const [showDriverModal, setShowDriverModal] = useState(false);
  const [driverForm, setDriverForm] = useState(EMPTY_DRIVER);
  const [editingDriverId, setEditingDriverId] = useState(null);
  const [driverSaving, setDriverSaving] = useState(false);
  const [brokerDetailId, setBrokerDetailId] = useState(null);
  const [driverDetailId, setDriverDetailId] = useState(null);
  const [clientDetail, setClientDetail] = useState(null);
  // Carrier settlements
  const [settlementsMissing, setSettlementsMissing] = useState(false);
  const [closingSheets, setClosingSheets] = useState([]);
  const [csTab, setCsTab] = useState("open");          // open | settled | disputed | all
  const [csDetailId, setCsDetailId] = useState(null);  // open closing-sheet detail page
  const [showCsModal, setShowCsModal] = useState(false);
  const [csForm, setCsForm] = useState(EMPTY_CS);
  const [editingCsId, setEditingCsId] = useState(null);
  const [csSaving, setCsSaving] = useState(false);
  const [csJobSearch, setCsJobSearch] = useState("");
  const [payModal, setPayModal] = useState(null);      // { job, amount, method, date, notes, entries:[] }
  const [docUploading, setDocUploading] = useState(false);
  const [calView, setCalView] = useState("week");      // week | month
  const [calAnchor, setCalAnchor] = useState(today());  // ISO date inside the visible range
  const [calDayMenu, setCalDayMenu] = useState(null);   // ISO date — "what to add" menu for a clicked day
  const [calAddExisting, setCalAddExisting] = useState(null); // { date } — search existing jobs to put on the calendar
  const [calAddSearch, setCalAddSearch] = useState("");
  const [calAddDate, setCalAddDate] = useState("");
  const [pickupEditor, setPickupEditor] = useState(null); // { from, to } — inline pickup-date editor inside job detail
  // Delivery calendar (same UX as the pickup calendar, indexed by delivery_date)
  const [dcalView, setDcalView] = useState("week");      // week | month
  const [dcalAnchor, setDcalAnchor] = useState(today()); // ISO date inside the visible range
  const [dcalDayMenu, setDcalDayMenu] = useState(null);  // ISO date — "what to add" menu for a clicked day
  const [dcalAddExisting, setDcalAddExisting] = useState(null); // { date } — search existing jobs to put on the delivery calendar
  const [dcalAddSearch, setDcalAddSearch] = useState("");
  const [dcalAddDate, setDcalAddDate] = useState("");
  const [dcalPanelOpen, setDcalPanelOpen] = useState(true); // "Entregas por agendar" strip
  // Trips / Live Load + trucks
  const [tripsMissing, setTripsMissing] = useState(false);
  const [truckLocMissing, setTruckLocMissing] = useState(false); // live-load location columns not yet in DB
  const [trips, setTrips] = useState([]);
  const [trucksList, setTrucksList] = useState([]);
  const [tripsView, setTripsView] = useState("active");  // active | all | live
  // Live-load map: status filter, selected truck, and the "set location" modal.
  const [liveStatusFilter, setLiveStatusFilter] = useState("all"); // all | moving | stopped
  const [liveSelTruck, setLiveSelTruck] = useState(null);
  const [locModal, setLocModal] = useState(null); // truck row | null
  const [locForm, setLocForm] = useState({ query:"", lat:"", lng:"", label:"", status:"stopped" });
  const [locBusy, setLocBusy] = useState(false);
  const [locErr, setLocErr] = useState(null);
  const [showTripModal, setShowTripModal] = useState(false);
  const [tripForm, setTripForm] = useState(EMPTY_TRIP);
  const [editingTripId, setEditingTripId] = useState(null);
  const [tripSaving, setTripSaving] = useState(false);
  const [tripJobSearch, setTripJobSearch] = useState("");
  // Custom (non-job) stops on a trip: maintenance, DOT inspection, fuel, etc.
  const [tripStops, setTripStops] = useState([]);
  const [tripStopsMissing, setTripStopsMissing] = useState(false); // trip_stops table not yet in DB
  // Equipment / materials tab (internal cargo, not customer jobs)
  const [equipmentItems, setEquipmentItems] = useState([]);
  const [equipmentMissing, setEquipmentMissing] = useState(false); // equipment_items table not yet in DB
  const [equipmentSearch, setEquipmentSearch] = useState("");
  const [showEquipmentModal, setShowEquipmentModal] = useState(false);
  const [equipmentForm, setEquipmentForm] = useState(EMPTY_EQUIPMENT);
  const [editingEquipmentId, setEditingEquipmentId] = useState(null);
  const [equipmentSaving, setEquipmentSaving] = useState(false);
  const [equipLoadItem, setEquipLoadItem] = useState(null);   // item being loaded onto a trip
  const [equipUnloadItem, setEquipUnloadItem] = useState(null); // {item, tripId} being unloaded at a destination
  const [addStopModal, setAddStopModal] = useState(null); // { trip } — the "add stop" popup
  const [stopForm, setStopForm] = useState({ category:"maintenance", address:"", note:"" });
  const [stopSaving, setStopSaving] = useState(false);
  // AI trip suggestions ("✨ Sugerir trips (IA)")
  const [showTripAI, setShowTripAI] = useState(false);
  const [tripAILoading, setTripAILoading] = useState(false);
  const [tripAIError, setTripAIError] = useState(null);
  const [tripAIResult, setTripAIResult] = useState(null); // { new_trips, trip_additions, unassigned, notes }
  // alert()/confirm() and interpolated strings render outside the DOM overlay's
  // reach (i18nApply), so they need explicit per-language branching.
  const trAI = (en, es) => (lang === "es" ? es : en);
  // Localized label for a custom-stop category (respects the user's language).
  const catLabel = (key) => { const c = tripStopCat(key); return trAI(c.label, c.es); };
  // Dynamic in-transit trip management
  const [tripDetailId, setTripDetailId] = useState(null);     // trip detail modal
  const [tripEvents, setTripEvents] = useState([]);
  const [tripEventsMissing, setTripEventsMissing] = useState(false);
  // Manual job timeline events
  const [jobEvents, setJobEvents] = useState([]);
  const [jobEventsMissing, setJobEventsMissing] = useState(false);
  const [jobEventForm, setJobEventForm] = useState(null);     // null = closed; else the add-event form
  const [tripLogOpen, setTripLogOpen] = useState(false);
  const [tripAddJobSearch, setTripAddJobSearch] = useState("");
  const [tripAction, setTripAction] = useState(null);         // "add" | "pickup" | "unplanned" | "handoff" | null
  const [handoffForm, setHandoffForm] = useState({ jobKey:"", to:"", reason:"better_fit", note:"" }); // jobKey "" = whole trip
  const [storageDropJob, setStorageDropJob] = useState(null); // { trip, jobKey } for the drop modal
  const [splitJobRow, setSplitJobRow] = useState(null);       // storage_jobs row being split across two trucks
  const [splitCf, setSplitCf] = useState("");                 // CF to peel onto the second truck
  const [splitDest, setSplitDest] = useState("");             // "" | "trip:<id>" | "truck:<id>" for the peeled portion
  const [dropModal, setDropModal] = useState(null); // { trip, jobKey, label } drop-at-storage popup (trip cards)
  const [dropSel, setDropSel] = useState("");       // selected drop target key ("u:<id>" | "w:<name>") in dropModal
  const [dropCreating, setDropCreating] = useState(false); // inline "create storage unit" form open in dropModal
  const [dropNewUnit, setDropNewUnit] = useState({ brand:"", unit:"", state:"", size:"" }); // quick-create fields
  const [dropCreatingBusy, setDropCreatingBusy] = useState(false);
  const [unplannedForm, setUnplannedForm] = useState(EMPTY_UNPLANNED);
  const [tripBusy, setTripBusy] = useState(false);
  const [tripCompleteModal, setTripCompleteModal] = useState(null); // { trip } completion summary
  const [tripRouteModal, setTripRouteModal] = useState(null); // { title, waypoints, googleLink } route popup
  const [completeDropTarget, setCompleteDropTarget] = useState("");
  const [tripWaLink, setTripWaLink] = useState(null);         // { href, label } pending driver notification
  const [showTruckModal, setShowTruckModal] = useState(false);
  const [truckForm, setTruckForm] = useState(EMPTY_TRUCK);
  const [editingTruckId, setEditingTruckId] = useState(null);
  const [truckSaving, setTruckSaving] = useState(false);
  const [truckColsMissing, setTruckColsMissing] = useState(false);   // vehicle-info columns
  const [truckDetailId, setTruckDetailId] = useState(null);          // truck detail modal
  // Extras & commissions
  const [extrasMissing, setExtrasMissing] = useState(false);
  const [extrasColsMissing, setExtrasColsMissing] = useState(false);  // extra-CF / fuel columns
  const [brokerShareMissing, setBrokerShareMissing] = useState(false);  // broker-share columns (job_extras + storage_jobs)
  const [extrasTabExpanded, setExtrasTabExpanded] = useState(() => new Set());  // collapsible driver/month cards
  const [jobExtras, setJobExtras] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [exDriver, setExDriver] = useState("");           // filter: driver id
  const [exRep, setExRep] = useState("");                 // filter: rep id
  const [exMonth, setExMonth] = useState(today().slice(0, 7)); // "YYYY-MM"
  const [exType, setExType] = useState("");               // filter: extra type
  const [exSearch, setExSearch] = useState("");           // filter: job # search
  const [extrasTab, setExtrasTab] = useState("drivers");  // drivers | reps
  const [showEmpModal, setShowEmpModal] = useState(false);
  const [empForm, setEmpForm] = useState(EMPTY_EMPLOYEE);
  const [empSaving, setEmpSaving] = useState(false);
  const [empDetailId, setEmpDetailId] = useState(null);   // rep profile open in the employees modal
  const [quickExtra, setQuickExtra] = useState(null);     // job-detail quick-add form
  // Payments
  const [paymentsMissing, setPaymentsMissing] = useState(false);
  const [payStageMissing, setPayStageMissing] = useState(false);
  const [payColsMissing, setPayColsMissing] = useState(false);   // detailed check/MO/CC columns
  const [splitMissing, setSplitMissing] = useState(false);       // split_group / extra_type / source / payment_id
  const [allocMissing, setAllocMissing] = useState(false);       // payments.job_extra_id (charge allocation)
  const [realCfMissing, setRealCfMissing] = useState(false);     // storage_jobs.real_cf (measured cubic feet)
  const [jobSplitColMissing, setJobSplitColMissing] = useState(false); // storage_jobs.split_group (job split across trips)
  const [tripPurposeColMissing, setTripPurposeColMissing] = useState(false); // storage_jobs.trip_purpose (delivery vs relocation)
  const [expandedSplits, setExpandedSplits] = useState(() => new Set());
  const [commAssign, setCommAssign] = useState(null);            // pending commission assignment for a payment-split extra
  const [payDocUploading, setPayDocUploading] = useState(false);
  const [payPhotoView, setPayPhotoView] = useState(null);        // url of photo viewed full-size
  const [payments, setPayments] = useState([]);
  const [payAccounts, setPayAccounts] = useState([]);
  const [payTab, setPayTab] = useState("all");            // all | pending | received | circulation | banked
  const [paySearch, setPaySearch] = useState("");         // job # / client / ref filter + "does this job have payments?" lookup
  const [depositSel, setDepositSel] = useState(() => new Set());  // payment ids ticked for batch deposit (circulation tab)
  const [depositForm, setDepositForm] = useState({ bank_account:"", date:"" });
  const [showAccountsModal, setShowAccountsModal] = useState(false);
  const [accountForm, setAccountForm] = useState(EMPTY_PAY_ACCOUNT);
  const [editingAccountId, setEditingAccountId] = useState(null);
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [accountSaving, setAccountSaving] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payForm, setPayForm] = useState(EMPTY_PAYMENT);
  const [editingPayId, setEditingPayId] = useState(null);
  const [paySaving, setPaySaving] = useState(false);
  const [payJobSearch, setPayJobSearch] = useState("");   // job search inside the payment form
  const [extraJobSearch, setExtraJobSearch] = useState(""); // job search inside the quick-extra modal (Payments page flow)
  const [reallocPay, setReallocPay] = useState(null);       // "A cuenta" payment being re-assigned to charges
  // Legal & Compliance
  const [complianceMissing, setComplianceMissing] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [complianceDocs, setComplianceDocs] = useState([]);
  const [compTab, setCompTab] = useState("companies");    // companies | trucks | drivers | all
  const [compBannerDismissed, setCompBannerDismissed] = useState(false);
  const [showCompanyModal, setShowCompanyModal] = useState(false);
  const [companyForm, setCompanyForm] = useState(EMPTY_COMPANY);
  const [editingCompanyId, setEditingCompanyId] = useState(null);
  const [companySaving, setCompanySaving] = useState(false);
  const [showDocModal, setShowDocModal] = useState(false);
  const [docForm, setDocForm] = useState(EMPTY_COMP_DOC);
  const [editingDocId, setEditingDocId] = useState(null);
  const [docSaving, setDocSaving] = useState(false);
  const [compDocUploading, setCompDocUploading] = useState(false);
  const [docFilterEntity, setDocFilterEntity] = useState("");   // all-docs filters
  const [docFilterStatus, setDocFilterStatus] = useState("");
  const [docFilterDays, setDocFilterDays] = useState("");
  const [toast, setToast] = useState(null);               // brief success notification
  const fileRef = useRef();
  const autoGenRef = useRef(false);
  const toastRef = useRef(null);

  useEffect(() => {
    // Invite/reset links land back here; show the "set your password" panel.
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("invited") || sp.get("reset")) setPwRecovery(true);
    } catch {}
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setPwRecovery(true);
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Load the current user's profile (role + per-section permissions) alongside session.
  useEffect(() => {
    if (!session) { setProfile(session === null ? null : undefined); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
      if (!cancelled) { setProfile(data || null); setNameInput(data?.full_name || ""); }
    })();
    return () => { cancelled = true; };
  }, [session]);

  const isAdmin = profile?.role === "admin";
  const can = useCallback((id, level = "view") =>
    (profile?.role === "admin") || !!profile?.permissions?.[id]?.[level], [profile]);

  // Save the current user's own display name (any user can edit their own).
  async function saveMyName() {
    setSavingName(true); setSettingsNotice(null);
    try {
      const res = await fetch("/api/admin-users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ action: "update_self", payload: { full_name: nameInput } }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
      const trimmed = nameInput.trim();
      setProfile(p => p ? { ...p, full_name: trimmed } : p);
      setNameInput(trimmed);
      setSettingsNotice("Saved.");
    } catch (e) { setSettingsNotice(e.message); }
    setSavingName(false);
  }

  // Change the current user's own password. Re-authenticates with the current
  // password first so a borrowed open session can't silently take over the account.
  async function changeMyPassword() {
    if (pwForm.next.length < 8) { setPwNotice({ ok:false, text:"Password must be at least 8 characters." }); return; }
    if (pwForm.next !== pwForm.confirm) { setPwNotice({ ok:false, text:"Passwords do not match." }); return; }
    setPwSaving(true); setPwNotice(null);
    const { error: authErr } = await supabase.auth.signInWithPassword({ email: session.user.email, password: pwForm.current });
    if (authErr) { setPwSaving(false); setPwNotice({ ok:false, text:"Current password is incorrect." }); return; }
    const { error } = await supabase.auth.updateUser({ password: pwForm.next });
    setPwSaving(false);
    if (error) setPwNotice({ ok:false, text: error.message });
    else { setPwNotice({ ok:true, text:"Password updated." }); setPwForm({ current:"", next:"", confirm:"" }); }
  }

  // Keep `page` pointed at a section the user is actually allowed to see.
  useEffect(() => {
    if (!profile) return;
    const allowed = (id) => id === "users" ? isAdmin : id === "suggestions" ? true : can(id, "view");
    if (!allowed(page)) {
      const first = SECTION_IDS.find(allowed);
      if (first) setPage(first);
    }
  }, [profile, page, isAdmin, can]);

  const loadData = useCallback(async () => {
    const { data, error } = await supabase.from("storages").select("*").order("date_opened", { ascending: false });
    if (error) { setError(error.message); setLoading(false); return; }
    setRecords(data || []);
    setLoading(false);
  }, []);

  const loadJobs = useCallback(async () => {
    const { data, error } = await supabase.from("storage_jobs").select("*").order("created_at", { ascending: false });
    if (!error) setJobs(data || []);
  }, []);

  const loadBrokers = useCallback(async () => {
    const { data, error } = await supabase.from("brokers").select("*").order("name", { ascending: true });
    if (!error) setBrokers(data || []);
  }, []);

  const loadBilling = useCallback(async () => {
    const { data, error } = await supabase.from("storage_billing").select("*").order("billing_period_end", { ascending: true });
    if (!error) { setBilling(data || []); setBillingLoaded(true); }
  }, []);

  const loadDrivers = useCallback(async () => {
    const { data, error } = await supabase.from("drivers").select("*").order("name", { ascending: true });
    if (!error) setDriversList(data || []);
  }, []);

  const loadClosingSheets = useCallback(async () => {
    const { data, error } = await supabase.from("closing_sheets").select("*").order("created_at", { ascending: false });
    if (!error) setClosingSheets(data || []);
  }, []);

  const loadTrips = useCallback(async () => {
    const { data, error } = await supabase.from("trips").select("*").order("created_at", { ascending: false });
    if (!error) setTrips(data || []);
  }, []);
  const loadTrucks = useCallback(async () => {
    const { data, error } = await supabase.from("trucks").select("*").order("name", { ascending: true });
    if (!error) setTrucksList(data || []);
  }, []);
  const loadTripEvents = useCallback(async () => {
    const { data, error } = await supabase.from("trip_events").select("*").order("created_at", { ascending: true });
    if (!error) setTripEvents(data || []);
  }, []);
  const loadTripStops = useCallback(async () => {
    const { data, error } = await supabase.from("trip_stops").select("*").order("stop_order", { ascending: true });
    if (!error) setTripStops(data || []);
  }, []);
  const loadEquipment = useCallback(async () => {
    const { data, error } = await supabase.from("equipment_items").select("*").order("created_at", { ascending: false });
    if (!error) setEquipmentItems(data || []);
  }, []);
  const loadJobEvents = useCallback(async () => {
    const { data, error } = await supabase.from("job_events").select("*").order("created_at", { ascending: true });
    if (!error) setJobEvents(data || []);
  }, []);
  const loadExtras = useCallback(async () => {
    const { data, error } = await supabase.from("job_extras").select("*").order("created_at", { ascending: false });
    if (!error) setJobExtras(data || []);
  }, []);
  const loadEmployees = useCallback(async () => {
    const { data, error } = await supabase.from("employees").select("*").order("name", { ascending: true });
    if (!error) setEmployees(data || []);
  }, []);
  const loadPayments = useCallback(async () => {
    const { data, error } = await supabase.from("payments").select("*").order("payment_date", { ascending: false });
    if (!error) setPayments(data || []);
  }, []);
  const loadPayAccounts = useCallback(async () => {
    const { data, error } = await supabase.from("payment_accounts").select("*").order("name", { ascending: true });
    if (!error) setPayAccounts(data || []);
  }, []);
  const loadCompanies = useCallback(async () => {
    const { data, error } = await supabase.from("companies").select("*").order("name", { ascending: true });
    if (!error) setCompanies(data || []);
  }, []);
  const loadComplianceDocs = useCallback(async () => {
    const { data, error } = await supabase.from("compliance_documents").select("*").order("expiry_date", { ascending: true });
    if (!error) setComplianceDocs(data || []);
  }, []);

  // Ensure storage_jobs exists. With a publishable (anon) key DDL isn't possible
  // via REST, so we probe the table and, if missing, best-effort create it through
  // an exec_sql-style RPC. If neither works, surface a one-time setup banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("id").limit(1);
      if (cancelled) return;
      if (!error) { setDbReady(true); setDbSetupNeeded(false); loadJobs(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: STORAGE_JOBS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { setDbReady(true); setDbSetupNeeded(false); loadJobs(); }
      else { setDbReady(false); setDbSetupNeeded(true); }
    })();
    return () => { cancelled = true; };
  }, [session, loadJobs]);

  useEffect(() => {
    if (!session || !dbReady) return;
    const channel = supabase.channel("storage-jobs-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storage_jobs" }, () => loadJobs())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, dbReady, loadJobs]);

  // Ensure the payment_due_date column exists; with the anon key DDL isn't
  // possible, so probe it and (if missing) try an exec_sql RPC, else flag a banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storages").select("payment_due_date").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storages add column if not exists payment_due_date date;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setPaymentColMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Same probe for the driver_id column on storages (who opens the unit).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storages").select("driver_id").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storages add column if not exists driver_id bigint;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setDriverColMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Same probe for the FADD column on storage_jobs.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("fadd").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storage_jobs add column if not exists fadd date;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setFaddColMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Probe the Dispatching CRM columns (job_type, status, pickup_*/delivery_*) on
  // storage_jobs; if missing, try exec_sql, else surface the setup banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("status").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: JOB_COLS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setJobColsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Probe the brokers table + balance columns (CRM v2). If present, load brokers
  // and subscribe to realtime; otherwise surface the setup banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: bErr } = await supabase.from("brokers").select("id").limit(1);
      const { error: balErr } = await supabase.from("storage_jobs").select("pickup_balance").limit(1);
      if (cancelled) return;
      if (!bErr && !balErr) { loadBrokers(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: CRM_V2_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadBrokers();
      else setCrmV2Missing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadBrokers]);

  useEffect(() => {
    if (!session || crmV2Missing) return;
    const channel = supabase.channel("brokers-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "brokers" }, () => loadBrokers())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, crmV2Missing, loadBrokers]);

  // Probe the CRM v3 extras (drivers table + rep column on storage_jobs).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: dErr } = await supabase.from("drivers").select("id").limit(1);
      const { error: rErr } = await supabase.from("storage_jobs").select("rep, pickup_date_from").limit(1);
      if (cancelled) return;
      if (!dErr && !rErr) { loadDrivers(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: CRM_V3_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadDrivers();
      else setCrmV3Missing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadDrivers]);

  useEffect(() => {
    if (!session || crmV3Missing) return;
    const channel = supabase.channel("drivers-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "drivers" }, () => loadDrivers())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, crmV3Missing, loadDrivers]);

  // Probe the manual calendar_status column (drives calendar colour). If it does
  // not exist yet, create it; then backfill any null rows from the legacy colour
  // logic so existing jobs keep their current colour and become fully manual.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const runRpc = async (sql) => { for (const fn of ["exec_sql", "exec", "execute_sql"]) { const { error } = await supabase.rpc(fn, { sql }); if (!error) return true; } return false; };
    const BACKFILL = "update public.storage_jobs set calendar_status = case " +
      "when status = 'cancelled' then 'cancelled' " +
      "when status = 'delivered' then 'delivered' " +
      "when status in ('on_hold','redispatched') then 'on_hold' " +
      "when status in ('in_storage','out_for_delivery') then 'long_haul' " +
      "else 'active' end where calendar_status is null;";
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("calendar_status").limit(1);
      if (cancelled) return;
      if (error) {
        // Column missing → add it, then backfill.
        const ok = await runRpc("alter table public.storage_jobs add column if not exists calendar_status text; " + BACKFILL);
        if (cancelled) return;
        if (ok) loadJobs(); else setCalStatusMissing(true);
        return;
      }
      // Column exists → backfill only the rows still null (one-time, harmless if none).
      const { data } = await supabase.from("storage_jobs").select("id").is("calendar_status", null).limit(1);
      if (cancelled || !data || data.length === 0) return;
      const ok = await runRpc(BACKFILL);
      if (cancelled) return;
      if (ok) loadJobs();
      else {
        // No SQL RPC — backfill row by row through the JS client.
        const { data: rows } = await supabase.from("storage_jobs").select("id, status, job_type, pickup_state, delivery_state").is("calendar_status", null);
        for (const r of (rows || [])) { if (cancelled) return; await supabase.from("storage_jobs").update({ calendar_status: legacyCalKey(r) }).eq("id", r.id); }
        if (!cancelled) loadJobs();
      }
    })();
    return () => { cancelled = true; };
  }, [session, loadJobs]);

  // Probe the Carrier Settlements module (closing_sheets table + BOL columns).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: tErr } = await supabase.from("closing_sheets").select("id").limit(1);
      const { error: jErr } = await supabase.from("storage_jobs").select("bol_balance, pads_received").limit(1);
      if (cancelled) return;
      if (!tErr && !jErr) { loadClosingSheets(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: SETTLEMENTS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadClosingSheets();
      else setSettlementsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadClosingSheets]);

  useEffect(() => {
    if (!session || settlementsMissing) return;
    const channel = supabase.channel("closing-sheets-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "closing_sheets" }, () => loadClosingSheets())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, settlementsMissing, loadClosingSheets]);

  // Probe the Trips / Live Load module (trips + trucks tables + trip_id column).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: tErr } = await supabase.from("trips").select("id").limit(1);
      const { error: kErr } = await supabase.from("trucks").select("id").limit(1);
      const { error: jErr } = await supabase.from("storage_jobs").select("trip_id").limit(1);
      if (cancelled) return;
      if (!tErr && !kErr && !jErr) { loadTrips(); loadTrucks(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: TRIPS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { loadTrips(); loadTrucks(); }
      else setTripsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadTrips, loadTrucks]);

  useEffect(() => {
    if (!session || tripsMissing) return;
    const channel = supabase.channel("trips-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, () => loadTrips())
      .on("postgres_changes", { event: "*", schema: "public", table: "trucks" }, () => loadTrucks())
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_events" }, () => loadTripEvents())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, tripsMissing, loadTrips, loadTrucks, loadTripEvents]);

  // Probe the trip_events table (dynamic in-transit changes; added after the initial Trips release).
  useEffect(() => {
    if (!session || tripsMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("trip_events").select("id").limit(1);
      if (cancelled) return;
      if (!error) { loadTripEvents(); return; }
      let created = false;
      const sql = "alter table public.trips add column if not exists trip_log jsonb default '[]'::jsonb; create table if not exists public.trip_events (id bigint generated always as identity primary key, trip_id bigint references public.trips(id) on delete cascade, event_type text, job_id bigint, storage_id bigint, notes text, created_by text, created_at timestamptz default now()); alter table public.trip_events enable row level security; drop policy if exists \"trip_events_all\" on public.trip_events; create policy \"trip_events_all\" on public.trip_events for all to anon, authenticated using (true) with check (true);";
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadTripEvents();
      else setTripEventsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, tripsMissing, loadTripEvents]);

  // Probe / auto-migrate the trip_stops table (custom non-job stops).
  useEffect(() => {
    if (!session || tripsMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("trip_stops").select("id").limit(1);
      if (cancelled) return;
      if (!error) { setTripStopsMissing(false); loadTripStops(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: TRIP_STOPS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { setTripStopsMissing(false); loadTripStops(); }
      else setTripStopsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, tripsMissing, loadTripStops]);

  useEffect(() => {
    if (!session || tripStopsMissing) return;
    const channel = supabase.channel("trip-stops-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_stops" }, () => loadTripStops())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, tripStopsMissing, loadTripStops]);

  // Probe / auto-migrate the equipment_items table (Equipment tab — internal cargo).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("equipment_items").select("id").limit(1);
      if (cancelled) return;
      if (!error) { setEquipmentMissing(false); loadEquipment(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: EQUIPMENT_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { setEquipmentMissing(false); loadEquipment(); }
      else setEquipmentMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadEquipment]);

  useEffect(() => {
    if (!session || equipmentMissing) return;
    const channel = supabase.channel("equipment-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "equipment_items" }, () => loadEquipment())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, equipmentMissing, loadEquipment]);

  // Probe the job_events table (manual per-job timeline; needs storage_jobs).
  useEffect(() => {
    if (!session || !dbReady) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("job_events").select("id").limit(1);
      if (cancelled) return;
      if (!error) { loadJobEvents(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: JOB_EVENTS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadJobEvents();
      else setJobEventsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, dbReady, loadJobEvents]);

  useEffect(() => {
    if (!session || jobEventsMissing) return;
    const channel = supabase.channel("job-events-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "job_events" }, () => loadJobEvents())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, jobEventsMissing, loadJobEvents]);

  // Probe the truck vehicle-info columns (added after the initial Trucks release).
  useEffect(() => {
    if (!session || tripsMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("trucks").select("vin").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.trucks add column if not exists vin text, add column if not exists make text, add column if not exists model text, add column if not exists year integer, add column if not exists license_plate text, add column if not exists license_state text;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setTruckColsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, tripsMissing]);

  // Probe / auto-migrate the live-load location columns on trucks.
  useEffect(() => {
    if (!session || tripsMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("trucks").select("last_lat").limit(1);
      if (cancelled) return;
      if (!error) { setTruckLocMissing(false); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.trucks add column if not exists last_lat numeric, add column if not exists last_lng numeric, add column if not exists last_location text, add column if not exists last_location_at timestamptz, add column if not exists last_status text, add column if not exists verizon_vehicle_id text;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled) setTruckLocMissing(!created);
    })();
    return () => { cancelled = true; };
  }, [session, tripsMissing]);

  // Probe the Extras & Commissions module (job_extras + employees tables).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: eErr } = await supabase.from("job_extras").select("id").limit(1);
      const { error: empErr } = await supabase.from("employees").select("id").limit(1);
      if (cancelled) return;
      if (!eErr && !empErr) { loadExtras(); loadEmployees(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: EXTRAS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { loadExtras(); loadEmployees(); }
      else setExtrasMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadExtras, loadEmployees]);

  useEffect(() => {
    if (!session || extrasMissing) return;
    const channel = supabase.channel("extras-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "job_extras" }, () => loadExtras())
      .on("postgres_changes", { event: "*", schema: "public", table: "employees" }, () => loadEmployees())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, extrasMissing, loadExtras, loadEmployees]);

  // Probe the Extra-CF / fuel-surcharge columns on job_extras (later release).
  useEffect(() => {
    if (!session || extrasMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("job_extras").select("extra_cf_count").limit(1);
      if (cancelled || !error) return;
      let created = false;
      const sql = "alter table public.job_extras add column if not exists extra_cf_count numeric, add column if not exists extra_cf_rate numeric, add column if not exists extra_cf_subtotal numeric, add column if not exists fuel_surcharge_pct numeric default 0, add column if not exists fuel_surcharge_amount numeric, add column if not exists extra_total_with_fuel numeric, add column if not exists commission_base text, add column if not exists commission_base_amount numeric;";
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setExtrasColsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, extrasMissing]);

  // Probe the broker-share columns (job_extras + storage_jobs).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: e1 } = extrasMissing ? { error: null } : await supabase.from("job_extras").select("broker_share_pct").limit(1);
      const { error: e2 } = await supabase.from("storage_jobs").select("broker_job_share_pct").limit(1);
      if (cancelled || (!e1 && !e2)) return;
      let created = false;
      const sql = (extrasMissing ? "" : "alter table public.job_extras add column if not exists broker_share_pct numeric default 0, add column if not exists broker_share_amount numeric, add column if not exists net_amount numeric; ") +
        "alter table public.storage_jobs add column if not exists broker_job_share_pct numeric default 0, add column if not exists broker_job_share_amount numeric;";
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setBrokerShareMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, extrasMissing]);

  // Probe the Payments module (payments + payment_accounts tables).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: pErr } = await supabase.from("payments").select("id").limit(1);
      const { error: aErr } = await supabase.from("payment_accounts").select("id").limit(1);
      if (cancelled) return;
      if (!pErr && !aErr) { loadPayments(); loadPayAccounts(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: PAYMENTS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { loadPayments(); loadPayAccounts(); }
      else setPaymentsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadPayments, loadPayAccounts]);

  useEffect(() => {
    if (!session || paymentsMissing) return;
    const channel = supabase.channel("payments-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => loadPayments())
      .on("postgres_changes", { event: "*", schema: "public", table: "payment_accounts" }, () => loadPayAccounts())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, paymentsMissing, loadPayments, loadPayAccounts]);

  // One-time migration: backfill `banked` on legacy payments where it is null so
  // every received payment is unambiguously banked or in-circulation. Digital
  // methods become banked = true (auto-deposited; keep/derive a deposit date),
  // physical cash/checks become banked = false (still in circulation).
  useEffect(() => {
    if (!session || paymentsMissing) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("payments").select("id").is("banked", null).limit(1);
      if (cancelled || error || !data || data.length === 0) return;   // nothing to migrate
      const sql = "update public.payments set banked = true, banked_date = coalesce(banked_date, received_date, payment_date) where banked is null and method is not null and method not in ('cash','check','money_order'); update public.payments set banked = false where banked is null and (method is null or method in ('cash','check','money_order'));";
      let ok = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql });
        if (!rpcErr) { ok = true; break; }
      }
      if (cancelled) return;
      if (!ok) {
        // No SQL RPC available — migrate row by row through the JS client.
        const { data: rows } = await supabase.from("payments").select("id, method, received_date, payment_date, banked_date").is("banked", null);
        for (const r of (rows || [])) {
          if (cancelled) return;
          const digital = isDigitalMethod(r.method);
          await supabase.from("payments").update({
            banked: digital,
            banked_date: digital ? (r.banked_date || r.received_date || r.payment_date || null) : null,
          }).eq("id", r.id);
        }
      }
      if (!cancelled) loadPayments();
    })();
    return () => { cancelled = true; };
  }, [session, paymentsMissing, loadPayments]);

  // Probe the Legal & Compliance module (companies + compliance_documents tables).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: cErr } = await supabase.from("companies").select("id").limit(1);
      const { error: dErr } = await supabase.from("compliance_documents").select("id").limit(1);
      if (cancelled) return;
      if (!cErr && !dErr) { loadCompanies(); loadComplianceDocs(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: COMPLIANCE_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { loadCompanies(); loadComplianceDocs(); }
      else setComplianceMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadCompanies, loadComplianceDocs]);

  useEffect(() => {
    if (!session || complianceMissing) return;
    const channel = supabase.channel("compliance-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "companies" }, () => loadCompanies())
      .on("postgres_changes", { event: "*", schema: "public", table: "compliance_documents" }, () => loadComplianceDocs())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, complianceMissing, loadCompanies, loadComplianceDocs]);

  // Probe the payment_stage column (added after the initial Payments release).
  useEffect(() => {
    if (!session || paymentsMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("payments").select("payment_stage").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.payments add column if not exists payment_stage text;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setPayStageMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, paymentsMissing]);

  // Probe the detailed check / money-order / CC-fee columns (later Payments release).
  useEffect(() => {
    if (!session || paymentsMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("payments").select("check_serial").limit(1);
      if (cancelled || !error) return;
      let created = false;
      const sql = "alter table public.payments add column if not exists check_serial text, add column if not exists check_transaction_number text, add column if not exists check_remitter text, add column if not exists check_purchased_by text, add column if not exists check_bank text, add column if not exists check_from text, add column if not exists check_routing text, add column if not exists check_account_last4 text, add column if not exists check_date date, add column if not exists check_memo text, add column if not exists check_photo_url text, add column if not exists mo_type text, add column if not exists mo_serial text, add column if not exists mo_date date, add column if not exists mo_post_office text, add column if not exists mo_from_name text, add column if not exists mo_from_address text, add column if not exists mo_payment_for text, add column if not exists mo_issuer_location text, add column if not exists mo_photo_url text, add column if not exists cc_fee_enabled boolean default false, add column if not exists cc_fee_pct numeric default 3, add column if not exists cc_fee_amount numeric, add column if not exists cc_fee_payment_id bigint;";
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setPayColsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, paymentsMissing]);

  // Probe the split-payment columns (payments.split_group/extra_type + job_extras.source/payment_id).
  useEffect(() => {
    if (!session || paymentsMissing) return;
    let cancelled = false;
    (async () => {
      const { error: e1 } = await supabase.from("payments").select("split_group").limit(1);
      const { error: e2 } = extrasMissing ? { error: null } : await supabase.from("job_extras").select("source").limit(1);
      if (cancelled || (!e1 && !e2)) return;
      let created = false;
      const sql = "alter table public.payments add column if not exists split_group text, add column if not exists extra_type text;" +
        (extrasMissing ? "" : " alter table public.job_extras add column if not exists source text default 'manual', add column if not exists payment_id bigint;");
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setSplitMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, paymentsMissing, extrasMissing]);

  // Probe payments.job_extra_id (charge-allocation release: links a payment
  // line to the specific extra it pays).
  useEffect(() => {
    if (!session || paymentsMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("payments").select("job_extra_id").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.payments add column if not exists job_extra_id bigint;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setAllocMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, paymentsMissing]);

  // Probe storage_jobs.real_cf (measured cubic feet loaded at pickup — the
  // broker estimate in `volume` stays as reference).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("real_cf").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storage_jobs add column if not exists real_cf numeric;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setRealCfMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Probe storage_jobs.split_group (marks a row as one portion of a job split
  // across two trucks/trips — same job_number, its own CF and trip_id).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("split_group").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storage_jobs add column if not exists split_group text;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setJobSplitColMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Probe storage_jobs.trip_purpose ('delivery' | 'relocation'; null = delivery).
  // Marks WHY a job rides its current trip: relocation legs move it between
  // locations without delivery semantics and without collecting its balances.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("trip_purpose").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storage_jobs add column if not exists trip_purpose text;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setTripPurposeColMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Probe the billing table + occupancy/billing columns (CRM v3).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: tErr } = await supabase.from("storage_billing").select("id").limit(1);
      const { error: sErr } = await supabase.from("storages").select("space_type").limit(1);
      const { error: jErr } = await supabase.from("storage_jobs").select("billing_active").limit(1);
      if (cancelled) return;
      if (!tErr && !sErr && !jErr) { loadBilling(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: BILLING_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadBilling();
      else setBillingMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadBilling]);

  useEffect(() => {
    if (!session || billingMissing) return;
    const channel = supabase.channel("billing-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storage_billing" }, () => loadBilling())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, billingMissing, loadBilling]);

  // Auto-generate billing: one pending record per active billing-active job for the
  // current 30-day period, and flip past-due pending records to overdue. Idempotent
  // (dedupes by job + period); converges once realtime reloads with nothing to do.
  useEffect(() => {
    if (!session || billingMissing || !billingLoaded || autoGenRef.current) return;
    const td = today();
    const groups = new Map();
    for (const j of jobs) {
      if (j.date_out || j.status === "cancelled") continue;
      const k = jobKey(j);
      if (!groups.has(k)) groups.set(k, j);
    }
    const toInsert = [];
    for (const rep of groups.values()) {
      if (!rep.billing_active) continue;
      const rate = Number(rep.client_monthly_rate);
      if (!rate || isNaN(rate)) continue;
      const start = rep.billing_start_date || (rep.first_month_free ? (rep.date_in ? addDaysStr(rep.date_in, 30) : null) : rep.date_in);
      if (!start || start > td) continue;
      let periodStart = start;
      while (addDaysStr(periodStart, 30) <= td) periodStart = addDaysStr(periodStart, 30);
      const periodEnd = addDaysStr(periodStart, 30);
      if (!billing.some(b => b.job_id === rep.id && b.billing_period_start === periodStart))
        toInsert.push({ job_id: rep.id, billing_period_start: periodStart, billing_period_end: periodEnd, amount: rate, status: "pending" });
    }
    const toOverdue = billing.filter(b => b.status === "pending" && b.billing_period_end && b.billing_period_end < td).map(b => b.id);
    if (!toInsert.length && !toOverdue.length) return;
    autoGenRef.current = true;
    (async () => {
      if (toInsert.length) await supabase.from("storage_billing").insert(toInsert);
      if (toOverdue.length) await supabase.from("storage_billing").update({ status: "overdue" }).in("id", toOverdue);
      await loadBilling();
      autoGenRef.current = false;
    })();
  }, [session, billingMissing, billingLoaded, jobs, billing, loadBilling]);

  // Probe the storage_jobs.billing_notes column (added with the Storage Billing redesign).
  useEffect(() => {
    if (!session || billingMissing) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("billing_notes").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storage_jobs add column if not exists billing_notes text;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setBillingNotesMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, billingMissing]);

  useEffect(() => {
    if (!session) return;
    loadData();
    const channel = supabase.channel("storages-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storages" }, (payload) => {
        setLiveIndicator(true);
        setTimeout(() => setLiveIndicator(false), 2000);
        if (payload.eventType === "INSERT") setRecords(r => [payload.new, ...r]);
        if (payload.eventType === "UPDATE") setRecords(r => r.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setRecords(r => r.filter(x => x.id !== payload.old.id));
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, loadData]);

  const storageById = useMemo(() => {
    const m = {};
    for (const r of records) m[r.id] = r;
    return m;
  }, [records]);

  const drivers = useMemo(() => [...new Set(jobs.map(j => j.driver).filter(Boolean))].sort(), [jobs]);
  const driverById = useMemo(() => { const m = {}; for (const d of driversList) m[d.id] = d; return m; }, [driversList]);
  // A job's driver names: prefer the drivers-table ids, fall back to the legacy text field.
  const jobDriverNames = useCallback((g) => {
    const ids = Array.isArray(g?.driver_ids) ? g.driver_ids : [];
    const names = ids.map(id => driverById[id]?.name).filter(Boolean);
    if (names.length) return names.join(", ");
    return g?.driver || "";
  }, [driverById]);
  const jobGroupLink = useCallback((g) => {
    const ids = Array.isArray(g?.driver_ids) ? g.driver_ids : [];
    for (const id of ids) { const l = driverById[id]?.whatsapp_group_link; if (l) return l; }
    return "";
  }, [driverById]);
  const brokerById = useMemo(() => { const m = {}; for (const b of brokers) m[b.id] = b; return m; }, [brokers]);
  const brokerName = useCallback((id) => (id && brokerById[id]?.name) || "", [brokerById]);
  const brands = useMemo(() => [...new Set(records.map(r => r.brand).filter(Boolean))].sort(), [records]);
  const sizes = useMemo(() => [...new Set([...STANDARD_SIZES, ...records.map(r => r.size).filter(Boolean)])], [records]);

  const activeJobsByStorage = useMemo(() => {
    const m = {};
    for (const j of jobs) if (jobInStorageNow(j) && j.storage_id) m[j.storage_id] = (m[j.storage_id] || 0) + 1;
    return m;
  }, [jobs]);

  // CF currently stored per rented unit and per owned warehouse (jobs physically
  // present only — excludes anything already loaded onto a truck / out for delivery).
  const usedCfByStorage = useMemo(() => {
    const m = {};
    for (const j of jobs) if (jobInStorageNow(j) && j.storage_id) m[j.storage_id] = (m[j.storage_id] || 0) + effCf(j);
    return m;
  }, [jobs]);
  const usedCfByWarehouse = useMemo(() => {
    const m = {};
    for (const j of jobs) if (jobInStorageNow(j) && j.warehouse) m[j.warehouse] = (m[j.warehouse] || 0) + effCf(j);
    return m;
  }, [jobs]);
  // Warehouse capacity is held in a storages row (space_type='warehouse', brand=name).
  const warehouseMeta = useMemo(() => {
    const m = {};
    for (const r of records) if (r.space_type === "warehouse" && r.brand) m[r.brand] = r;
    return m;
  }, [records]);

  // Active jobs stored in rented units — one row per (job, unit) so you see what's
  // inside each unit. Filtered by the storage search box, sorted by company/unit.
  const unitJobRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs
      .filter(j => jobInStorageNow(j) && j.storage_id)
      .map(j => ({ ...j, storage: storageById[j.storage_id] || null }))
      .filter(j => {
        if (!q) return true;
        const s = j.storage || {};
        const hay = [j.job_number, j.customer, j.driver, j.lot_number, j.sticker_color, s.brand, s.unit, s.address, s.state, s.zip].join(" ").toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const ab = (a.storage?.brand || "").localeCompare(b.storage?.brand || "");
        if (ab !== 0) return ab;
        return (a.storage?.unit || "").localeCompare(b.storage?.unit || "");
      });
  }, [jobs, storageById, search]);

  // Derived situation: Close is manual; otherwise Open if it has active jobs, else Empty.
  const sit = useCallback(
    (r) => r.situation === "Close" ? "Close" : ((activeJobsByStorage[r.id] || 0) > 0 ? "Open" : "Empty"),
    [activeJobsByStorage]
  );

  // Job-first view: jobs grouped by job number (a job may span several locations).
  // You search a job number and instantly see all the places WHERE it is.
  const jobGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const parts = jobs
      .filter(j => {
        if (tab === "delivered") return j.date_out;                // delivered → out of storage
        if (tab === "active") return !j.date_out;                  // all active (any status)
        return !j.date_out && (j.status || "scheduled") === tab;   // a specific status tab
      })
      .map(j => ({ ...j, storage: storageById[j.storage_id] || null }))
      .filter(j => {
        if (driverFilter && j.driver !== driverFilter) return false;
        if (q) {
          const s = j.storage || {};
          const hay = [j.job_number, j.customer, j.driver, j.notes, j.warehouse, j.lot_number, j.sticker_color, j.delivery_address, j.delivery_state, j.delivery_zip, s.brand, s.state, s.zip, s.address, s.unit, s.gate_code].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    const map = new Map();
    for (const p of [...parts].sort(moneyRowFirst)) {
      const key = jobKey(p);
      if (!map.has(key)) map.set(key, { key, job_number:p.job_number, customer:p.customer, driver:p.driver, date_in:p.date_in, date_out:p.date_out, fadd:p.fadd, volume:p.volume, lot_number:p.lot_number, sticker_color:p.sticker_color, job_type:p.job_type, status:p.status, broker_id:p.broker_id, rep:p.rep, client_phone:p.client_phone, client_email:p.client_email, driver_ids:p.driver_ids, extra_stops:p.extra_stops, price_per_cf:p.price_per_cf, fuel_surcharge_pct:p.fuel_surcharge_pct, estimate:p.estimate, deposit:p.deposit, carrier_notes:p.carrier_notes, billing_active:p.billing_active, client_monthly_rate:p.client_monthly_rate, first_month_free:p.first_month_free, billing_start_date:p.billing_start_date, pickup_balance:p.pickup_balance, delivery_balance:p.delivery_balance, closing_sheet_id:p.closing_sheet_id, carrier_rate_per_cf:p.carrier_rate_per_cf, bol_balance:p.bol_balance, bol_collected:p.bol_collected, pads_received:p.pads_received, pads_returned:p.pads_returned, trip_id:p.trip_id, trip_stop_order:p.trip_stop_order, pickup_date:p.pickup_date, pickup_date_from:p.pickup_date_from, pickup_date_to:p.pickup_date_to, pickup_address:p.pickup_address, pickup_city:p.pickup_city, pickup_state:p.pickup_state, pickup_zip:p.pickup_zip, delivery_date:p.delivery_date, delivery_address:p.delivery_address, delivery_city:p.delivery_city, delivery_state:p.delivery_state, delivery_zip:p.delivery_zip, notes:p.notes, parts:[] });
      map.get(key).parts.push(p);
    }
    const arr = [...map.values()];
    if (tab === "dispatch") {
      // Most urgent FADD first; jobs with no FADD go to the bottom.
      arr.sort((a, b) => {
        const da = daysUntilFadd(a.fadd), db = daysUntilFadd(b.fadd);
        return (da === null ? Infinity : da) - (db === null ? Infinity : db);
      });
    } else {
      arr.sort((a, b) => {
        const ad = a.date_in || "", bd = b.date_in || "";
        if (sortBy === "date-asc") return ad > bd ? 1 : -1;
        if (sortBy === "customer") return (a.customer || "").localeCompare(b.customer || "");
        if (sortBy === "driver") return (a.driver || "").localeCompare(b.driver || "");
        return bd > ad ? 1 : -1;
      });
    }
    return arr;
  }, [jobs, storageById, tab, search, driverFilter, sortBy]);

  // Distinct job counts per Jobs sub-tab (status pipeline), for the tab badges.
  const jobTabCounts = useMemo(() => {
    const sets = { active:new Set(), delivered:new Set(), scheduled:new Set(), in_storage:new Set(), out_for_delivery:new Set() };
    for (const j of jobs) {
      const k = jobKey(j);
      if (j.date_out) { sets.delivered.add(k); continue; }
      sets.active.add(k);
      const s = j.status || "scheduled";
      if (sets[s]) sets[s].add(k);
    }
    return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.size]));
  }, [jobs]);

  // Reset to the first page whenever the filtered list changes (filters run over
  // the full set; pagination is applied on top).
  useEffect(() => { setListPage(0); }, [search, sortBy, driverFilter, page, storageTab, unitsSubTab, tab]);

  // Units view: manage the physical lockers themselves.
  const unitRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const data = records.filter(r => {
      if (r.space_type === "warehouse") return false;   // warehouses live in their own tab
      if (mapStateFilter && r.state !== mapStateFilter) return false;  // filtered by a dot on the map
      if (!q) return true;
      const hay = [r.brand, r.state, r.zip, r.address, r.unit, r.gate_code].join(" ").toLowerCase();
      return hay.includes(q);
    });
    data.sort((a, b) => {
      if (sortBy === "date-asc") return (a.date_opened || "") > (b.date_opened || "") ? 1 : -1;
      if (sortBy === "customer" || sortBy === "driver") return (a.brand || "").localeCompare(b.brand || "");
      return (b.date_opened || "") > (a.date_opened || "") ? 1 : -1;
    });
    return data;
  }, [records, search, sortBy, mapStateFilter]);

  // Active rented storages grouped by state for the US map (count, CF in use, due alerts).
  const storageStateStats = useMemo(() => {
    const m = {};
    for (const r of records) {
      if (r.space_type === "warehouse") continue;
      if (sit(r) !== "Open") continue;                 // active = currently occupied
      if (!r.state || !US_CODE_TO_NAME[r.state]) continue;
      const st = (m[r.state] = m[r.state] || { count:0, cf:0, due:0 });
      st.count += 1;
      st.cf += usedCfByStorage[r.id] || 0;
      const d = daysUntilDue(r);
      if (d !== null && d <= 5) st.due += 1;
    }
    return m;
  }, [records, sit, usedCfByStorage]);


  // Payments coming due on active units (not Closed/Empty).
  const urgentPayments = useMemo(
    () => records.filter(r => sit(r) === "Open" && (() => { const d = daysUntilDue(r); return d !== null && d <= 5; })()).length,
    [records, sit]
  );
  const duePaymentsSoon = useMemo(
    () => records.filter(r => sit(r) === "Open" && (() => { const d = daysUntilDue(r); return d !== null && d <= 3; })())
      .map(r => ({ id:r.id, label: [r.brand, r.unit].filter(Boolean).join(" ") || r.address || `Unit #${r.id}`, days: daysUntilDue(r) }))
      .sort((a, b) => a.days - b.days),
    [records, sit]
  );

  // FADD dispatching stats (distinct active jobs).
  const faddStats = useMemo(() => {
    const overdue = new Set(), dueWeek = new Set();
    for (const j of jobs) {
      if (j.date_out) continue;
      const d = daysUntilFadd(j.fadd);
      if (d === null) continue;
      if (d < 0) overdue.add(jobKey(j));
      else if (d <= 7) dueWeek.add(jobKey(j));
    }
    return { overdue: overdue.size, dueWeek: dueWeek.size };
  }, [jobs]);

  // Dispatching board: every non-delivered, non-cancelled job grouped by job
  // number, enriched with storage info, filtered by the active sub-tab + search.
  const dispatchGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const parts = jobs
      .filter(j => (!j.date_out && j.status !== "cancelled")
        || (j.job_type === "broker_delivery" && numv(j.bol_balance) > 0 && numv(j.bol_collected) < numv(j.bol_balance))) // keep broker deliveries with pending BOL visible
      .map(j => ({ ...j, storage: storageById[j.storage_id] || null }))
      .filter(j => {
        if (driverFilter && j.driver !== driverFilter) return false;
        if (q) {
          const s = j.storage || {};
          const hay = [j.job_number, j.customer, j.driver, j.notes, j.warehouse, j.lot_number, j.sticker_color,
            j.pickup_address, j.pickup_city, j.pickup_state, j.delivery_address, j.delivery_city, j.delivery_state, j.delivery_zip,
            s.brand, s.state, s.zip, s.address, s.unit].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    const map = new Map();
    for (const p of [...parts].sort(moneyRowFirst)) {
      const key = jobKey(p);
      if (!map.has(key)) map.set(key, { key, job_number:p.job_number, customer:p.customer, driver:p.driver, date_in:p.date_in, fadd:p.fadd, volume:p.volume, lot_number:p.lot_number, sticker_color:p.sticker_color, job_type:p.job_type, status:p.status, broker_id:p.broker_id, rep:p.rep, client_phone:p.client_phone, client_email:p.client_email, driver_ids:p.driver_ids, extra_stops:p.extra_stops, price_per_cf:p.price_per_cf, fuel_surcharge_pct:p.fuel_surcharge_pct, estimate:p.estimate, deposit:p.deposit, carrier_notes:p.carrier_notes, billing_active:p.billing_active, client_monthly_rate:p.client_monthly_rate, first_month_free:p.first_month_free, billing_start_date:p.billing_start_date, pickup_balance:p.pickup_balance, delivery_balance:p.delivery_balance, closing_sheet_id:p.closing_sheet_id, carrier_rate_per_cf:p.carrier_rate_per_cf, bol_balance:p.bol_balance, bol_collected:p.bol_collected, pads_received:p.pads_received, pads_returned:p.pads_returned, trip_id:p.trip_id, trip_stop_order:p.trip_stop_order, pickup_date:p.pickup_date, pickup_date_from:p.pickup_date_from, pickup_date_to:p.pickup_date_to, pickup_address:p.pickup_address, pickup_city:p.pickup_city, pickup_state:p.pickup_state, pickup_zip:p.pickup_zip, delivery_date:p.delivery_date, delivery_address:p.delivery_address, delivery_city:p.delivery_city, delivery_state:p.delivery_state, delivery_zip:p.delivery_zip, notes:p.notes, parts:[] });
      map.get(key).parts.push(p);
    }
    let arr = [...map.values()];
    const td = today();
    if (dispatchFilter === "pickups_today") arr = arr.filter(g => { const f = g.pickup_date_from || g.pickup_date; return f && f <= td && td <= (g.pickup_date_to || f); });
    else if (dispatchFilter === "deliveries_today") arr = arr.filter(g => g.delivery_date === td);
    else if (dispatchFilter === "in_storage") arr = arr.filter(g => (g.status || "scheduled") === "in_storage");
    else if (dispatchFilter === "on_hold") arr = arr.filter(g => (g.status || "scheduled") === "on_hold");
    else if (dispatchFilter === "no_trip") arr = arr.filter(g => !g.trip_id);
    else if (dispatchFilter === "nofadd") arr = arr.filter(g => !g.fadd);
    else if (dispatchFilter === "no_delivery") arr = arr.filter(g => !g.delivery_date);
    // Most urgent FADD first; jobs with no FADD sink to the bottom.
    arr.sort((a, b) => {
      const da = daysUntilFadd(a.fadd), db = daysUntilFadd(b.fadd);
      return (da === null ? Infinity : da) - (db === null ? Infinity : db);
    });
    return arr;
  }, [jobs, storageById, search, driverFilter, dispatchFilter]);

  // Calendar: pickups grouped by job and indexed by date. A job with a date range
  // (pickup_date_from..pickup_date_to) is shown spanning every day in that range.
  const pickupEvents = useMemo(() => {
    const map = new Map();
    const byDate = {};
    for (const j of jobs) {
      const from = j.pickup_date_from || j.pickup_date;
      if (!from) continue;
      const k = jobKey(j);
      if (!map.has(k)) map.set(k, { key:k, job_number:j.job_number, customer:j.customer, status:j.status, calendar_status:j.calendar_status, job_type:j.job_type, driver:j.driver, driver_ids:j.driver_ids, pickup_date:j.pickup_date, pickup_date_from:from, pickup_date_to:(j.pickup_date_to || from), pickup_state:j.pickup_state, delivery_state:j.delivery_state });
    }
    for (const g of map.values()) {
      let d = g.pickup_date_from;
      const end = (g.pickup_date_to >= g.pickup_date_from) ? g.pickup_date_to : g.pickup_date_from;
      let guard = 0;
      while (d <= end && guard < 400) { (byDate[d] = byDate[d] || []).push(g); d = addDaysStr(d, 1); guard++; }
    }
    return byDate;
  }, [jobs]);

  // Delivery calendar: deliveries grouped by job and indexed by delivery_date
  // (a single day — unlike pickups, deliveries have no date range).
  const deliveryEvents = useMemo(() => {
    const map = new Map();
    const byDate = {};
    for (const j of jobs) {
      if (!j.delivery_date) continue;
      const k = jobKey(j);
      if (!map.has(k)) map.set(k, { key:k, job_number:j.job_number, customer:j.customer, status:j.status, calendar_status:j.calendar_status, job_type:j.job_type, driver:j.driver, driver_ids:j.driver_ids, delivery_date:j.delivery_date, pickup_state:j.pickup_state, delivery_state:j.delivery_state });
    }
    for (const g of map.values()) (byDate[g.delivery_date] = byDate[g.delivery_date] || []).push(g);
    return byDate;
  }, [jobs]);

  // Jobs that should get a delivery date: picked up and waiting (in storage /
  // warehouse / client not ready) or broker deliveries, with no delivery_date yet.
  // Grouped by job (ids collects every row so scheduling patches split jobs too)
  // and sorted by FADD urgency, no-FADD last. Deliberately NOT filtered by trip_id:
  // a job dropped at storage mid-trip keeps its trip_id and is a prime candidate.
  const deliveryCandidates = useMemo(() => {
    const map = new Map();
    for (const j of jobs) {
      if (j.date_out || j.delivery_date) continue;
      const st = j.status || "scheduled";
      if (st === "cancelled" || st === "delivered" || st === "out_for_delivery") continue;
      const stored = st === "in_storage" || st === "picked_up" || j.storage_id || j.warehouse;
      if (!stored && j.job_type !== "broker_delivery") continue;
      const k = jobKey(j);
      if (!map.has(k)) map.set(k, { key:k, job_number:j.job_number, customer:j.customer, fadd:j.fadd, job_type:j.job_type, status:st, warehouse:j.warehouse, storage_id:j.storage_id, delivery_city:j.delivery_city, delivery_state:j.delivery_state, ids:[] });
      const g = map.get(k);
      g.ids.push(j.id);
      // Split jobs: a later row may carry the field the first one lacks.
      if (!g.fadd && j.fadd) g.fadd = j.fadd;
      if (!g.warehouse && j.warehouse) g.warehouse = j.warehouse;
      if (!g.storage_id && j.storage_id) g.storage_id = j.storage_id;
    }
    return [...map.values()].sort((a, b) => {
      const da = daysUntilFadd(a.fadd), db = daysUntilFadd(b.fadd);
      return (da === null ? Infinity : da) - (db === null ? Infinity : db);
    });
  }, [jobs]);
  // Menu badge: candidates whose FADD is within a week (or overdue).
  const deliveryToSchedule = useMemo(() => deliveryCandidates.filter(c => {
    const d = daysUntilFadd(c.fadd);
    return d !== null && d <= 7;
  }).length, [deliveryCandidates]);

  // Top-bar metrics for the Dispatching page (distinct active jobs).
  const dispatchMetrics = useMemo(() => {
    const td = today();
    const pickups = new Set(), deliveries = new Set(), inStorage = new Set(), active = new Set(), seen = new Set();
    let puBal = 0, delBal = 0;
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    for (const j of jobs) {
      if (j.date_out || j.status === "cancelled") continue;
      const k = jobKey(j);
      active.add(k);
      { const f = j.pickup_date_from || j.pickup_date; if (f && f <= td && td <= (j.pickup_date_to || f)) pickups.add(k); }
      if (j.delivery_date === td) deliveries.add(k);
      if (j.status === "in_storage") inStorage.add(k);
      if (!seen.has(k)) {
        seen.add(k);
        if ((j.status || "scheduled") === "scheduled") puBal += num(j.pickup_balance); // pending until picked up
        delBal += num(j.delivery_balance); // pending until delivered
      }
    }
    return { pickups: pickups.size, deliveries: deliveries.size, inStorage: inStorage.size, active: active.size, puBal, delBal };
  }, [jobs]);

  // Dispatching alert banner: FADD overdue, or a pickup/delivery scheduled today
  // with no driver assigned. Grouped by job.
  const dispatchAlerts = useMemo(() => {
    const td = today();
    const map = new Map();
    for (const j of jobs) {
      if (j.date_out || j.status === "cancelled") continue;
      const d = daysUntilFadd(j.fadd);
      const overdue = d !== null && d < 0;
      const todayNoDriver = (j.pickup_date === td || j.delivery_date === td) && !j.driver;
      if (!overdue && !todayNoDriver) continue;
      const k = jobKey(j);
      if (!map.has(k)) map.set(k, { key:k, job_number:j.job_number, customer:j.customer, reason: overdue ? "FADD overdue" : "No driver for today" });
    }
    return [...map.values()];
  }, [jobs]);

  // Billing rows enriched with client/job/location info for the Billing table.
  const billingRows = useMemo(() => {
    const byId = {}; for (const j of jobs) byId[j.id] = j;
    return billing.map(b => {
      const j = byId[b.job_id];
      const s = j ? storageById[j.storage_id] : null;
      const loc = j && j.warehouse ? `Warehouse ${j.warehouse}`
        : (s ? [s.brand, s.unit && "U"+s.unit].filter(Boolean).join(" ") : "—");
      const dateIn = j?.date_in || null;
      const daysIn = dateIn ? Math.max(0, Math.round((startOfToday() - new Date(dateIn + "T00:00:00")) / ONE_DAY)) : null;
      return { ...b, customer: j?.customer || "—", job_number: j?.job_number || "—", location: loc, date_in: dateIn, daysIn };
    });
  }, [billing, jobs, storageById]);

  // One card per active-billing job (deduped), enriched with its latest billing period.
  const billingClients = useMemo(() => {
    const latest = {};   // job_id -> latest billing record (by period start)
    for (const b of billing) {
      const cur = latest[b.job_id];
      if (!cur || (b.billing_period_start || "") > (cur.billing_period_start || "")) latest[b.job_id] = b;
    }
    const seen = new Set(); const out = [];
    for (const j of jobs) {
      if (j.date_out || j.status === "cancelled" || !j.billing_active) continue;
      const k = jobKey(j); if (seen.has(k)) continue; seen.add(k);
      const rec = latest[j.id] || null;
      const s = storageById[j.storage_id];
      const location = j.warehouse ? `Warehouse ${j.warehouse}`
        : (s ? [s.brand, s.unit && "U" + s.unit, s.state].filter(Boolean).join(" ") : "—");
      const daysIn = j.date_in ? Math.max(0, Math.round((startOfToday() - new Date(j.date_in + "T00:00:00")) / ONE_DAY)) : null;
      const rate = Number(j.client_monthly_rate) || 0;
      out.push({
        id: j.id, jobKey: k, rec, job: j,
        customer: j.customer || "—", job_number: j.job_number || "—", location, daysIn,
        rate, first_month_free: !!j.first_month_free, billing_start_date: j.billing_start_date || null,
        status: rec?.status || "pending",
        period_start: rec?.billing_period_start || null, period_end: rec?.billing_period_end || null,
        amount: rec ? Number(rec.amount || 0) : rate,
      });
    }
    return out.sort((a, b) => (a.customer || "").localeCompare(b.customer || ""));
  }, [jobs, billing, storageById]);

  const billingMetrics = useMemo(() => {
    const td = today();
    const monthPrefix = td.slice(0, 7);
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    let pending = 0, overdueSum = 0, overdueCount = 0, weekSum = 0, weekCount = 0, collected = 0;
    for (const b of billing) {
      const amt = num(b.amount);
      if (b.status === "pending") {
        pending += amt;
        const d = b.billing_period_end ? Math.round((new Date(b.billing_period_end + "T00:00:00") - startOfToday()) / ONE_DAY) : null;
        if (d !== null && d >= 0 && d <= 7) { weekSum += amt; weekCount++; }
      } else if (b.status === "overdue") {
        pending += amt; overdueSum += amt; overdueCount++;
      } else if (b.status === "paid" && b.paid_date && b.paid_date.slice(0, 7) === monthPrefix) {
        collected += amt;
      }
    }
    return { pending, overdueSum, overdueCount, weekSum, weekCount, collected };
  }, [billing]);

  const billingOverdueCount = useMemo(() => billing.filter(b => b.status === "overdue").length, [billing]);

  // Clients derived from jobs, grouped by customer name.
  const clients = useMemo(() => {
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    const m = new Map();
    const seenJob = new Set();
    for (const j of jobs) {
      const name = (j.customer || "").trim();
      if (!name) continue;
      const k = name.toLowerCase();
      if (!m.has(k)) m.set(k, { name, phone:"", email:"", jobs:new Set(), active:new Set(), balance:0 });
      const c = m.get(k);
      if (j.client_phone && !c.phone) c.phone = j.client_phone;
      if (j.client_email && !c.email) c.email = j.client_email;
      const jk = jobKey(j);
      c.jobs.add(jk);
      if (!j.date_out && j.status !== "cancelled") c.active.add(jk);
      const bk = k + "|" + jk;
      if (!seenJob.has(bk)) { seenJob.add(bk); if (!j.date_out) c.balance += num(j.pickup_balance) + num(j.delivery_balance); }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [jobs]);

  // Sidebar alert badges.
  const sidebarBadges = useMemo(() => ({
    dispatching: faddStats.overdue,
    calendario_entregas: deliveryToSchedule,
    billing: billingOverdueCount,
    storage: urgentPayments,
  }), [faddStats.overdue, deliveryToSchedule, billingOverdueCount, urgentPayments]);

  // ── Carrier settlements derived data ──
  const sheetById = useMemo(() => { const m = {}; for (const s of closingSheets) m[s.id] = s; return m; }, [closingSheets]);
  // Distinct-by-job storage_jobs rows assigned to each closing sheet.
  const jobsBySheet = useMemo(() => {
    const m = {};
    const seen = new Set();
    for (const j of jobs) {
      if (!j.closing_sheet_id) continue;
      const k = j.closing_sheet_id + "|" + jobKey(j);
      if (seen.has(k)) continue; seen.add(k);
      (m[j.closing_sheet_id] = m[j.closing_sheet_id] || []).push(j);
    }
    return m;
  }, [jobs]);
  const sheetCalcById = useMemo(() => {
    const m = {};
    for (const s of closingSheets) m[s.id] = sheetCalc(s, jobsBySheet[s.id] || []);
    return m;
  }, [closingSheets, jobsBySheet]);
  const settlementMetrics = useMemo(() => {
    let openCount = 0, owesUs = 0, weOwe = 0, pendingBol = 0, padsValue = 0;
    for (const s of closingSheets) {
      const c = sheetCalcById[s.id] || {};
      if (s.status === "open") { openCount++; pendingBol += c.pending || 0; padsValue += c.padsCharge || 0; }
      if (s.status !== "settled") { if ((c.net || 0) > 0) owesUs += c.net; else weOwe += -(c.net || 0); }
    }
    return { openCount, owesUs, weOwe, pendingBol, padsValue };
  }, [closingSheets, sheetCalcById]);
  // Per-broker settlement rollup (non-settled sheets).
  const brokerSettleStats = useMemo(() => {
    const m = {};
    for (const s of closingSheets) {
      const c = sheetCalcById[s.id] || {};
      if (!s.broker_id) continue;
      if (!m[s.broker_id]) m[s.broker_id] = { open:0, owesUs:0, weOwe:0 };
      if (s.status === "open") m[s.broker_id].open++;
      if (s.status !== "settled") { if ((c.net||0) > 0) m[s.broker_id].owesUs += c.net; else m[s.broker_id].weOwe += -(c.net||0); }
    }
    return m;
  }, [closingSheets, sheetCalcById]);

  // ── Trips / Live Load derived data ──
  const truckById = useMemo(() => { const m = {}; for (const t of trucksList) m[t.id] = t; return m; }, [trucksList]);
  const tripById = useMemo(() => { const m = {}; for (const t of trips) m[t.id] = t; return m; }, [trips]);
  // Distinct-by-job storage_jobs rows assigned to each trip, ordered by stop order.
  const jobsByTrip = useMemo(() => {
    const m = {}; const seen = new Set();
    for (const j of jobs) {
      if (!j.trip_id) continue;
      const sk = j.trip_id + "|" + tripUnitKey(j);
      if (seen.has(sk)) continue; seen.add(sk);
      (m[j.trip_id] = m[j.trip_id] || []).push(j);
    }
    for (const id of Object.keys(m)) m[id].sort((a, b) => (a.trip_stop_order ?? 9999) - (b.trip_stop_order ?? 9999));
    return m;
  }, [jobs]);
  const tripCalc = useCallback((trip) => {
    const jobsIn = jobsByTrip[trip.id] || [];
    // totalCf = everything assigned to the trip; loadedCf = what is physically on
    // the truck right now — delivered jobs and jobs sitting in storage (dropped
    // mid-trip or not picked up yet) don't take up space. Occupancy uses loadedCf
    // so the bar matches the stops' "Delivered" / "Dropped in storage" badges.
    let totalCf = 0, loadedCf = 0, totalCollect = 0, delivered = 0, deliveryCount = 0, relocCount = 0, relocDone = 0;
    // storage_drop events log the unit's min row id; a row is covered when any
    // row of its unit (same job_number, non-split) appears in the set.
    const dropIds = new Set();
    for (const e of tripEvents) { if (e.trip_id === trip.id && e.event_type === "storage_drop" && e.job_id != null) dropIds.add(e.job_id); }
    const unitDropped = (j) => dropIds.has(j.id) || (!j.split_group && !!j.job_number && jobsIn.some(x => x.id !== j.id && x.job_number === j.job_number && dropIds.has(x.id)));
    for (const j of jobsIn) {
      const cf = effCf(j);
      totalCf += cf;
      // Relocation legs never collect on this trip: they move the job between
      // locations, so their balances stay off the manifest / dashboard money.
      // A relocation is done only once its storage_drop event exists — in_storage
      // alone also matches a job still waiting at its origin location.
      if (isRelocation(j)) {
        relocCount++;
        if (j.status === "in_storage" && unitDropped(j)) relocDone++;
      } else {
        deliveryCount++; totalCollect += jobToCollect(j);
        if (j.date_out || j.status === "delivered") delivered++;
      }
      if (!(j.date_out || j.status === "delivered") && j.status !== "in_storage") loadedCf += cf;
    }
    const cap = numv(truckById[trip.truck_id]?.capacity_cf);
    const occPct = cap > 0 ? Math.round((loadedCf / cap) * 100) : null;
    return { jobsIn, totalCf, loadedCf, totalCollect, delivered, deliveryCount, relocCount, relocDone, count: jobsIn.length, cap, occPct,
      allDelivered: jobsIn.length > 0 && delivered === deliveryCount && relocDone === relocCount };
  }, [jobsByTrip, truckById, tripEvents]);
  const tripMetrics = useMemo(() => {
    const td = today();
    let activeCount = 0, cfTransit = 0, collectTransit = 0, deliveredToday = 0;
    for (const t of trips) {
      if (TRIP_ACTIVE(t.status)) { const c = tripCalc(t); activeCount++; cfTransit += c.loadedCf; collectTransit += c.totalCollect; }
    }
    for (const j of jobs) { if (j.trip_id && j.date_out === td) deliveredToday++; }
    return { activeCount, cfTransit, collectTransit, deliveredToday };
  }, [trips, jobs, tripCalc]);
  // Custom (non-job) stops grouped by trip, ordered by stop_order then creation.
  const tripStopsByTrip = useMemo(() => {
    const m = {};
    for (const s of tripStops) { (m[s.trip_id] = m[s.trip_id] || []).push(s); }
    for (const id of Object.keys(m)) m[id].sort((a, b) => (a.stop_order ?? 9999) - (b.stop_order ?? 9999) || (a.created_at || "").localeCompare(b.created_at || ""));
    return m;
  }, [tripStops]);
  // Unified stop sequence per trip: jobs and custom stops interleaved in one
  // 1..N order. Jobs order by trip_stop_order, custom stops by stop_order; both
  // share the same integer space (persistUnifiedOrder renumbers across both).
  const tripSequenceByTrip = useMemo(() => {
    const m = {};
    const ids = new Set([...Object.keys(jobsByTrip), ...Object.keys(tripStopsByTrip)]);
    for (const id of ids) {
      const items = [
        ...(jobsByTrip[id] || []).map(j => ({ kind:"job", order: j.trip_stop_order ?? 9999, j, key: "j:" + tripUnitKey(j) })),
        ...(tripStopsByTrip[id] || []).map(s => ({ kind:"custom", order: s.stop_order ?? 9999, s, key: "c:" + s.id })),
      ];
      items.sort((a, b) => (a.order - b.order) || (a.kind === b.kind ? 0 : a.kind === "job" ? -1 : 1));
      m[id] = items;
    }
    return m;
  }, [jobsByTrip, tripStopsByTrip]);
  // Trip events grouped by trip (newest first) for the audit log.
  const tripEventsByTrip = useMemo(() => {
    const m = {};
    for (const e of tripEvents) { (m[e.trip_id] = m[e.trip_id] || []).push(e); }
    for (const id of Object.keys(m)) m[id].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return m;
  }, [tripEvents]);
  // Jobs sitting in storage / a warehouse and not on any trip — candidates to "pick up".
  const jobsInStorage = useMemo(() => {
    const m = new Map();
    for (const j of jobs) {
      if (j.date_out || j.trip_id) continue;
      if (j.status !== "in_storage" && !j.storage_id && !j.warehouse) continue;
      if (j.status === "delivered" || j.status === "cancelled") continue;
      const k = tripUnitKey(j);
      if (!m.has(k)) m.set(k, j);
    }
    return [...m.values()];
  }, [jobs]);
  // AI trip suggestions — candidate pool: available jobs (scheduled / picked up)
  // plus everything sitting in storage or a warehouse, not on any trip yet.
  const tripCandidateJobs = useMemo(() => {
    const m = new Map();
    for (const j of jobs) {
      if (j.trip_id || j.date_out) continue;
      if (!["scheduled", "picked_up", "in_storage"].includes(j.status)) continue;
      const k = tripUnitKey(j);
      if (!m.has(k)) m.set(k, j);
    }
    return [...m.values()];
  }, [jobs]);
  // Trucks with capacity and no active trip — candidates for a new AI-suggested trip.
  const freeTrucks = useMemo(() => {
    const busy = new Set(trips.filter(t => TRIP_ACTIVE(t.status)).map(t => t.truck_id).filter(Boolean));
    return trucksList.filter(tk => numv(tk.capacity_cf) > 0 && !busy.has(tk.id));
  }, [trucksList, trips]);
  // Trips still loading with meaningful free capacity — candidates for AI top-ups.
  // In-transit trips are excluded: adding jobs to those goes through the manual
  // dynamic-load flow (driver notification + audit events), not suggestions.
  const loadingTripsWithRoom = useMemo(() => {
    const out = [];
    for (const t of trips) {
      if (t.status !== "loading") continue;
      const c = tripCalc(t);
      if (!(c.cap > 0) || c.totalCf >= c.cap * 0.9) continue;
      out.push({
        trip_id: t.id,
        trip_number: t.trip_number || `#${t.id}`,
        truck_name: truckById[t.truck_id]?.name || "",
        capacity_cf: c.cap,
        current_cf: Math.round(c.totalCf),
        stops: c.jobsIn.map(j => [j.delivery_city, j.delivery_state].filter(Boolean).join(", ")).filter(Boolean),
      });
    }
    return out;
  }, [trips, tripCalc, truckById]);

  // ── Legal & Compliance derived data (declared before sidebarBadgesPlus, which reads it) ──
  const companyById = useMemo(() => { const m = {}; for (const c of companies) m[c.id] = c; return m; }, [companies]);
  // Display name for a doc's entity (company/truck/driver).
  const entityName = useCallback((type, id) => {
    if (type === "company") return companyById[id]?.name || "—";
    if (type === "truck") { const t = truckById[id]; return t ? (t.name || `Truck #${id}`) : "—"; }
    if (type === "driver") return driverById[id]?.name || "—";
    return "—";
  }, [companyById, truckById, driverById]);
  // Docs grouped by `${entity_type}:${entity_id}` for the card grids.
  const docsByEntity = useMemo(() => {
    const m = {};
    for (const d of complianceDocs) { const k = `${d.entity_type}:${d.entity_id}`; (m[k] = m[k] || []).push(d); }
    return m;
  }, [complianceDocs]);
  // The latest (newest) doc of a given type for an entity (what each grid cell shows).
  const docFor = useCallback((type, id, docType) => {
    const arr = (docsByEntity[`${type}:${id}`] || []).filter(d => d.document_type === docType);
    if (!arr.length) return null;
    return arr.sort((a, b) => (b.issue_date || b.created_at || "").localeCompare(a.issue_date || a.created_at || ""))[0];
  }, [docsByEntity]);
  // Worst status among an entity's docs, for the card header badge.
  const entityStatus = useCallback((type, id) => {
    const arr = docsByEntity[`${type}:${id}`] || [];
    let worst = "active";
    for (const d of arr) { const s = docStatus(d); if (s === "expired") return "expired"; if (s === "expiring_soon") worst = "expiring_soon"; }
    return arr.length ? worst : "none";
  }, [docsByEntity]);
  const complianceMetrics = useMemo(() => {
    let expired = 0, expiringSoon = 0, upToDate = 0;
    for (const d of complianceDocs) { const s = docStatus(d); if (s === "expired") expired++; else if (s === "expiring_soon") expiringSoon++; else if (s === "active") upToDate++; }
    return { activeCompanies: companies.filter(c => c.active !== false).length, expired, expiringSoon, upToDate };
  }, [complianceDocs, companies]);
  // Docs expired or expiring within 7 days → alert banner + sidebar badge.
  const complianceAlerts = useMemo(() => {
    const rows = [];
    for (const d of complianceDocs) {
      const s = docStatus(d);
      const days = docDaysToExpiry(d);
      if (s === "expired" || (s === "expiring_soon" && days !== null && days <= 7)) {
        rows.push({ doc: d, status: s, days, name: entityName(d.entity_type, d.entity_id) });
      }
    }
    return rows.sort((a, b) => (a.days ?? 0) - (b.days ?? 0));
  }, [complianceDocs, entityName]);

  const sidebarBadgesPlus = useMemo(() => ({ ...sidebarBadges, settlements: settlementMetrics.openCount || 0, trips: tripMetrics.activeCount || 0, compliance: complianceAlerts.length || 0, messages: chatUnread || 0 }), [sidebarBadges, settlementMetrics.openCount, tripMetrics.activeCount, complianceAlerts.length, chatUnread]);

  // Team-chat unread badge while the Messages section is closed. Realtime rows
  // respect RLS, so only channels visible to this user arrive here. When the
  // section is open it owns the count (via onUnreadTotal) — skip increments.
  const pageRef = useRef(page); pageRef.current = page;
  useEffect(() => {
    if (!session) return;
    const channel = supabase.channel("chat-badge")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => {
        if (payload.new.sender_id !== session.user.id && pageRef.current !== "messages")
          setChatUnread(n => n + 1);
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session]);
  useEffect(() => { if (page === "messages") setChatUnread(0); }, [page]);

  // Online presence: every signed-in tab announces itself on a shared Realtime
  // Presence channel (keyed by user id); the synced key set = who's online.
  useEffect(() => {
    if (!session) return;
    const ch = supabase.channel("online-users", { config: { presence: { key: session.user.id } } });
    ch.on("presence", { event: "sync" }, () => setOnlineIds(Object.keys(ch.presenceState())))
      .subscribe(status => { if (status === "SUBSCRIBED") ch.track({ online_at: new Date().toISOString() }); });
    return () => { supabase.removeChannel(ch); setOnlineIds([]); };
  }, [session]);

  // Last-connection heartbeat: stamp my chat_presence row every minute while
  // the app is open (silently a no-op until the chat receipts SQL is run).
  useEffect(() => {
    if (!session) return;
    const beat = () => { supabase.from("chat_presence").upsert({ user_id: session.user.id, last_seen_at: new Date().toISOString() }).then(() => {}); };
    beat();
    const iv = setInterval(beat, 60_000);
    const onVis = () => { if (document.visibilityState === "visible") beat(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [session]);

  // Trip status is MANUAL only — never auto-changed from job delivery state.
  // The `allDelivered` flag (from tripCalc) is used solely to surface a
  // non-blocking "ready to complete?" suggestion inside the trip detail.

  // ── Extras & commissions derived data ──
  const empById = useMemo(() => { const m = {}; for (const e of employees) m[e.id] = e; return m; }, [employees]);
  const jobKeyByRowId = useMemo(() => { const m = {}; for (const j of jobs) m[j.id] = jobKey(j); return m; }, [jobs]);
  // Distinct-by-jobKey job groups (light) for the extras module, with a representative
  // row id (smallest) used as the FK target when creating extras.
  const extraJobGroups = useMemo(() => {
    const m = new Map();
    for (const j of jobs) {
      const k = jobKey(j);
      if (!m.has(k)) m.set(k, { key:k, job_number:j.job_number, customer:j.customer, broker_id:j.broker_id, rep:j.rep, date_in:j.date_in, created_at:j.created_at, driver_ids: Array.isArray(j.driver_ids) ? j.driver_ids : [], status:j.status, job_type:j.job_type, pickup_balance:j.pickup_balance, delivery_balance:j.delivery_balance, bol_balance:j.bol_balance, delivery_date:j.delivery_date, pickup_date:j.pickup_date_from || j.pickup_date, anyDelivered:false, ids:[] });
      const g = m.get(k);
      g.ids.push(j.id);
      if (!g.date_in && j.date_in) g.date_in = j.date_in;
      if (j.date_out || j.status === "delivered") g.anyDelivered = true;
    }
    for (const g of m.values()) g.repId = Math.min(...g.ids);
    return m;
  }, [jobs]);
  // Expected to be collected for a job = pickup + delivery balances (+ broker BOL balance).
  const jobExpected = useCallback((g) => g ? jobToCollect(g) : 0, []);
  const groupMonth = useCallback((g) => (g.date_in || g.created_at || "").slice(0, 7), []);
  const extrasByJobKey = useMemo(() => {
    const m = {};
    for (const e of jobExtras) { const k = jobKeyByRowId[e.job_id]; if (!k) continue; (m[k] = m[k] || []).push(e); }
    return m;
  }, [jobExtras, jobKeyByRowId]);
  const jobKeysWithExtras = useMemo(() => {
    const s = new Set();
    for (const e of jobExtras) { if (e.active === false) continue; const k = jobKeyByRowId[e.job_id]; if (k) s.add(k); }
    return s;
  }, [jobExtras, jobKeyByRowId]);
  const extraMetrics = useMemo(() => {
    let total = 0, driverComm = 0, repComm = 0, company = 0;
    for (const e of jobExtras) {
      if (e.active === false) continue;
      const k = jobKeyByRowId[e.job_id]; const g = k ? extraJobGroups.get(k) : null;
      const mo = g ? groupMonth(g) : (e.created_at || "").slice(0, 7);
      if (exMonth && mo !== exMonth) continue;
      total += numv(e.amount); driverComm += numv(e.driver_commission_amount);
      repComm += numv(e.rep_commission_amount); company += numv(e.company_amount);
    }
    return { total, driverComm, repComm, company };
  }, [jobExtras, jobKeyByRowId, extraJobGroups, groupMonth, exMonth]);

  // ── Payments derived data ──
  const paymentsByJobKey = useMemo(() => {
    const m = {};
    for (const p of payments) { const k = jobKeyByRowId[p.job_id]; if (!k) continue; (m[k] = m[k] || []).push(p); }
    return m;
  }, [payments, jobKeyByRowId]);
  // Charge state of a job (job balance + each extra, with per-charge remaining)
  // — feeds the payment-allocation panel and the per-extra chips in the drawer.
  const chargeStateByJobKey = useCallback((key) => buildJobCharges({
    expected: jobExpected(extraJobGroups.get(key)),
    extras: extrasByJobKey[key] || [],
    payments: paymentsByJobKey[key] || [],
  }), [extraJobGroups, jobExpected, extrasByJobKey, paymentsByJobKey]);
  // Net received per job (only payments flagged received), for outstanding-balance math.
  const jobReceivedByKey = useMemo(() => {
    const m = {};
    for (const p of payments) { if (!p.received) continue; const k = jobKeyByRowId[p.job_id]; if (!k) continue; m[k] = (m[k] || 0) + paymentNet(p); }
    return m;
  }, [payments, jobKeyByRowId]);
  // Enrich each payment with its job group for table/grouping/search.
  const paymentRows = useMemo(() => payments.map(p => {
    const k = jobKeyByRowId[p.job_id];
    const g = k ? extraJobGroups.get(k) : null;
    return { ...p, _key:k, _g:g, _net: paymentNet(p) };
  }), [payments, jobKeyByRowId, extraJobGroups]);
  const paymentMetrics = useMemo(() => {
    const mo = today().slice(0, 7);
    let expected = 0, received = 0, inCirc = 0, inCircThisMonth = 0, banked = 0, ccFees = 0;
    for (const g of extraJobGroups.values()) { if (g.status !== "cancelled") expected += jobExpected(g); }
    for (const p of payments) {
      const net = paymentNet(p);
      const recvMonth = (p.received_date || p.payment_date || "").slice(0, 7);
      if (p.received && recvMonth === mo) received += net;
      if (isPhysical(p.method) && p.received && !effectiveBanked(p)) {
        inCirc += net;                                   // all undeposited cash, any month
        if (recvMonth === mo) inCircThisMonth += net;    // ...just this month's portion
      }
      if (p.received && effectiveBanked(p) && bankedDateOf(p).slice(0, 7) === mo) banked += net;
      if (p.concept === "cc_fee" && (p.payment_date || "").slice(0, 7) === mo) ccFees += numv(p.amount);
    }
    return { expected, received, inCirc, inCircThisMonth, banked, pending: Math.max(0, expected - received), ccFees };
  }, [payments, extraJobGroups, jobExpected]);
  // Cash physically held but not yet banked, that's been sitting >7 days.
  const stalePayments = useMemo(() => paymentRows
    .filter(p => isPhysical(p.method) && p.received && !p.banked && daysSince(p.received_date || p.payment_date) > 7)
    .sort((a, b) => daysSince(b.received_date || b.payment_date) - daysSince(a.received_date || a.payment_date)),
  [paymentRows]);
  // "In circulation" grouped by the person physically holding the money.
  const circulation = useMemo(() => {
    const m = {};
    for (const p of paymentRows) {
      if (!(isPhysical(p.method) && p.received && !p.banked)) continue;
      const who = ((p.cash_with_whom || p.received_by || "").trim()) || "— Unassigned —";
      if (!m[who]) m[who] = { name:who, total:0, cash:0, check:0, money_order:0, items:[] };
      m[who].total += p._net; m[who][p.method] = (m[who][p.method] || 0) + p._net; m[who].items.push(p);
    }
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [paymentRows]);

  // ── Duplicate detection ──────────────────────────────────────────────
  const dismissDup = useCallback((key) => setDismissedDups(prev => {
    const n = new Set(prev); n.add(key);
    try { localStorage.setItem("dismissedDups", JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  }), []);
  // The job number shown for a payment row.
  const payJobNumber = useCallback((p) => {
    const k = jobKeyByRowId[p.job_id]; const g = k ? extraJobGroups.get(k) : null;
    return g?.job_number || (p.job_id ? "#" + p.job_id : "—");
  }, [jobKeyByRowId, extraJobGroups]);
  // Real-time finders (run against in-memory, realtime-synced data).
  const findJobNumberDup = useCallback((num) => {
    const n = (num || "").trim(); if (!n) return null;
    const nl = n.toLowerCase();
    const match = jobs.find(j => (j.job_number || "").trim().toLowerCase() === nl && jobKey(j) !== editingJobKey);
    if (!match) return null;
    const k = jobKey(match);
    const group = jobs.filter(j => jobKey(j) === k);
    const rep = group[0];
    const delivered = group.some(j => j.date_out) || rep.status === "delivered";
    const dateOut = group.map(j => j.date_out).filter(Boolean).sort().slice(-1)[0] || null;
    return { key: k, job_number: rep.job_number, customer: rep.customer, status: rep.status, date: rep.date_in || (rep.created_at || "").slice(0, 10) || "—", delivered, dateOut };
  }, [jobs, editingJobKey]);
  const findCheckSerialDup = useCallback((serial) => {
    const s = (serial || "").trim(); if (!s) return null;
    const sl = s.toLowerCase();
    const match = payments.find(p => (p.check_serial || "").trim().toLowerCase() === sl && p.id !== editingPayId);
    if (!match) return null;
    return { id: match.id, serial: match.check_serial, amount: numv(match.amount), date: match.payment_date || (match.created_at || "").slice(0, 10) || "—", job_number: payJobNumber(match), job_key: jobKeyByRowId[match.job_id] || null };
  }, [payments, editingPayId, payJobNumber, jobKeyByRowId]);
  const findMoSerialDup = useCallback((serial) => {
    const s = (serial || "").trim(); if (!s) return null;
    const sl = s.toLowerCase();
    const match = payments.find(p => (p.mo_serial || "").trim().toLowerCase() === sl && p.id !== editingPayId);
    if (!match) return null;
    return { id: match.id, serial: match.mo_serial, amount: numv(match.amount), date: match.payment_date || (match.created_at || "").slice(0, 10) || "—", job_number: payJobNumber(match), job_key: jobKeyByRowId[match.job_id] || null };
  }, [payments, editingPayId, payJobNumber, jobKeyByRowId]);
  const findStorageDup = useCallback((brand, unit, state) => {
    const bl = (brand || "").trim().toLowerCase(), ul = (unit || "").trim().toLowerCase(), stl = (state || "").trim().toLowerCase();
    if (!bl || !ul) return null;
    const match = records.find(r => r.space_type !== "warehouse" && (r.situation || "Open") !== "Close"
      && (r.brand || "").trim().toLowerCase() === bl && (r.unit || "").trim().toLowerCase() === ul && (r.state || "").trim().toLowerCase() === stl);
    if (!match) return null;
    return { id: match.id, brand: match.brand, unit: match.unit, state: match.state };
  }, [records]);

  // Debounced real-time field checks for the open forms.
  const [jobNumDeb, jobNumChecking] = useDebounced(jobForm.job_number || "");
  const jobNumberDup = useMemo(() => findJobNumberDup(jobNumDeb), [jobNumDeb, findJobNumberDup]);
  const [chkSerialDeb, chkSerialChecking] = useDebounced(payForm.check_serial || "");
  const checkSerialDup = useMemo(() => payForm.method === "check" ? findCheckSerialDup(chkSerialDeb) : null, [chkSerialDeb, payForm.method, findCheckSerialDup]);
  const [moSerialDeb, moSerialChecking] = useDebounced(payForm.mo_serial || "");
  const moSerialDup = useMemo(() => payForm.method === "money_order" ? findMoSerialDup(moSerialDeb) : null, [moSerialDeb, payForm.method, findMoSerialDup]);
  const [stBrandDeb, stBrandChecking] = useDebounced(`${form.brand || ""}|${form.unit || ""}|${form.state || ""}`);
  const storageDup = useMemo(() => {
    if (editId) return null;            // only warn for NEW units
    const [b, u, st] = stBrandDeb.split("|");
    return findStorageDup(b, u, st);
  }, [stBrandDeb, editId, findStorageDup]);

  // Global duplicate report (jobs / payments / storages), minus dismissed ones.
  const duplicateReport = useMemo(() => {
    // Jobs: same job_number used for ≥2 different customers (multi-unit jobs share a customer).
    const byNum = {};
    for (const j of jobs) { const n = (j.job_number || "").trim().toLowerCase(); if (!n) continue; (byNum[n] = byNum[n] || []).push(j); }
    const jobDups = [];
    for (const rows of Object.values(byNum)) {
      const byCust = {};
      for (const r of rows) { const c = (r.customer || "").trim() || "(no client)"; (byCust[c] = byCust[c] || []).push(r); }
      if (Object.keys(byCust).length >= 2) {
        const variants = Object.entries(byCust).map(([customer, rs]) => ({ customer, ids: rs.map(r => r.id), status: rs[0].status, date: rs[0].date_in || (rs[0].created_at || "").slice(0, 10), key: jobKey(rs[0]) }));
        jobDups.push({ key: "job:" + (rows[0].job_number || "").toLowerCase(), number: rows[0].job_number, variants });
      }
    }
    // Payments: same check/MO serial across ≥2 logical payments (split lines share a serial legitimately).
    const serials = {};
    for (const p of payments) {
      const s = (p.check_serial || p.mo_serial || "").trim(); if (!s) continue;
      const kind = p.check_serial ? "Check" : "MO";
      const key = (p.check_serial ? "chk:" : "mo:") + s.toLowerCase();
      const logical = p.split_group || ("p" + p.id);
      if (!serials[key]) serials[key] = { serial: s, kind, rows: [], logical: new Set() };
      serials[key].rows.push(p); serials[key].logical.add(logical);
    }
    const payDups = [];
    for (const [key, v] of Object.entries(serials)) if (v.logical.size >= 2) payDups.push({ key: "pay:" + key, serial: v.serial, kind: v.kind, rows: v.rows });
    // Storages: ≥2 open units sharing brand + unit + state.
    const stKeys = {};
    for (const r of records) {
      if (r.space_type === "warehouse") continue;
      if ((r.situation || "Open") === "Close") continue;
      const b = (r.brand || "").trim().toLowerCase(), u = (r.unit || "").trim().toLowerCase(), st = (r.state || "").trim().toLowerCase();
      if (!b || !u) continue;
      const k = `${b}|${u}|${st}`; (stKeys[k] = stKeys[k] || []).push(r);
    }
    const stDups = [];
    for (const [k, rows] of Object.entries(stKeys)) if (rows.length >= 2) stDups.push({ key: "st:" + k, rows });
    const f = (arr) => arr.filter(d => !dismissedDups.has(d.key));
    const jobsF = f(jobDups), paymentsF = f(payDups), storagesF = f(stDups);
    return { jobs: jobsF, payments: paymentsF, storages: storagesF, total: jobsF.length + paymentsF.length + storagesF.length };
  }, [jobs, payments, records, dismissedDups]);

  // Delete specific storage_jobs rows (a duplicate variant), cleaning up links.
  async function deleteJobRows(ids, label) {
    if (!ids || !ids.length) return;
    if (!window.confirm(`Delete ${label || "these job rows"}? This action cannot be undone.`)) return;
    if (!extrasMissing) await supabase.from("job_extras").delete().in("job_id", ids);
    if (!paymentsMissing) await supabase.from("payments").delete().in("job_id", ids);
    await supabase.from("storage_jobs").update({ closing_sheet_id: null }).in("id", ids);
    const { error } = await supabase.from("storage_jobs").delete().in("id", ids);
    if (error) { window.alert(error.message); return; }
    setJobs(prev => prev.filter(j => !ids.includes(j.id)));
    showToast("Duplicate record deleted");
    loadJobs(); if (!paymentsMissing) loadPayments(); if (!extrasMissing) loadExtras();
  }

  const detail = records.find(r => r.id === detailId);

  // All parts (units) of the job currently open in the job-detail modal.
  const jobDetail = useMemo(() => {
    if (!jobDetailKey) return null;
    const parts = jobs.filter(j => jobKey(j) === jobDetailKey).map(j => ({ ...j, storage: storageById[j.storage_id] || null }));
    if (!parts.length) return null;
    // Representative for the job-level fields (money, billing, addresses): the row
    // that carries the money — a non-split unit if any, else the original (lowest id)
    // split row. Split portions have their money zeroed, so never let one be `f`.
    const f = parts.find(p => !p.split_group) || parts.reduce((a, b) => (b.id < a.id ? b : a));
    return { key:jobDetailKey, job_number:f.job_number, customer:f.customer, driver:f.driver, driver_ids:f.driver_ids, date_in:f.date_in, fadd:f.fadd, volume:f.volume, lot_number:f.lot_number, sticker_color:f.sticker_color, job_type:f.job_type, status:f.status, calendar_status:f.calendar_status, broker_id:f.broker_id, rep:f.rep, client_phone:f.client_phone, client_email:f.client_email, extra_stops:f.extra_stops, price_per_cf:f.price_per_cf, fuel_surcharge_pct:f.fuel_surcharge_pct, estimate:f.estimate, deposit:f.deposit, carrier_notes:f.carrier_notes, closing_sheet_id:f.closing_sheet_id, carrier_rate_per_cf:f.carrier_rate_per_cf, bol_balance:f.bol_balance, bol_collected:f.bol_collected, bol_payment_method:f.bol_payment_method, bol_payment_notes:f.bol_payment_notes, bol_collected_date:f.bol_collected_date, pads_received:f.pads_received, pads_returned:f.pads_returned, broker_job_share_pct:f.broker_job_share_pct, broker_job_share_amount:f.broker_job_share_amount, trip_id:f.trip_id, trip_stop_order:f.trip_stop_order, pickup_balance:f.pickup_balance, delivery_balance:f.delivery_balance, pickup_date:f.pickup_date, pickup_date_from:f.pickup_date_from, pickup_date_to:f.pickup_date_to, pickup_address:f.pickup_address, pickup_city:f.pickup_city, pickup_state:f.pickup_state, pickup_zip:f.pickup_zip, delivery_date:f.delivery_date, delivery_address:f.delivery_address, delivery_city:f.delivery_city, delivery_state:f.delivery_state, delivery_zip:f.delivery_zip, billing_active:f.billing_active, client_monthly_rate:f.client_monthly_rate, first_month_free:f.first_month_free, billing_start_date:f.billing_start_date, notes:f.notes, created_by:f.created_by, created_at:f.created_at, updated_by:f.updated_by, updated_at:f.updated_at, parts };
  }, [jobDetailKey, jobs, storageById]);

  // Close the inline pickup-date editor whenever the open job detail changes.
  useEffect(() => { setPickupEditor(null); }, [jobDetailKey]);

  const userEmail = session?.user?.email || null;
  // Apply / revert the Spanish UI overlay whenever the language changes.
  useEffect(() => {
    try { localStorage.setItem("lang", lang); } catch { /* ignore */ }
    if (lang !== "es") { i18nRestore(); return; }
    let scheduled = false; let obs;
    const OPTS = { childList: true, subtree: true, characterData: true };
    const run = () => { if (obs) obs.disconnect(); i18nApply(); if (obs) obs.observe(document.body, OPTS); };
    obs = new MutationObserver(() => { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; run(); }); });
    run();
    return () => { obs.disconnect(); i18nRestore(); };
  }, [lang]);

  function openAdd() { setForm(EMPTY_FORM); setEditId(null); setShowAdd(true); }
  function openEdit(r) {
    setForm({ brand:r.brand||"", state:r.state||"", zip:r.zip||"", address:r.address||"", unit:r.unit||"", size:r.size||"", gate_code:r.gate_code||"", lock:r.lock||"", email:r.email||"", account:r.account||"", phone:r.phone||"", situation:r.situation==="Close"?"Close":"Open", monthly_cost:r.monthly_cost||"", card_on_file:r.card_on_file||"", date_opened:r.date_opened||"", payment_due_date:r.payment_due_date||"", driver_id:r.driver_id ? String(r.driver_id) : "" });
    setEditId(r.id); setShowAdd(true);
  }

  async function saveForm() {
    // New unit duplicating an existing open unit → block with confirmation.
    if (!editId) {
      const dup = findStorageDup(form.brand, form.unit, form.state);
      if (dup && !window.confirm(`${dup.brand} Unit ${dup.unit}${dup.state ? ` en ${dup.state}` : ""} is already open in the system.\n\nAre you sure you want to create a duplicate?`)) return;
    }
    setSaving(true);
    const payload = { brand:form.brand||null, state:form.state||null, zip:form.zip||null, address:form.address||null, unit:form.unit||null, size:form.size||null, gate_code:form.gate_code||null, lock:form.lock||null, email:form.email||null, account:form.account||null, phone:form.phone||null, situation:form.situation, monthly_cost:form.monthly_cost ? parseFloat(form.monthly_cost) : null, card_on_file:form.card_on_file||null, date_opened:form.date_opened||null };
    // Auto-set payment due date (date_opened + 30) when empty — only if the column exists.
    if (!paymentColMissing) payload.payment_due_date = form.payment_due_date || (form.date_opened ? addDaysStr(form.date_opened, 30) : null);
    // Driver who opens the unit — only if the column exists.
    if (!driverColMissing) payload.driver_id = form.driver_id ? Number(form.driver_id) : null;
    if (editId) { await supabase.from("storages").update({ ...payload, updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", editId); }
    else { await supabase.from("storages").insert([{ ...payload, created_by: userEmail }]); }
    setSaving(false); setShowAdd(false);
  }

  function openAddJob(storageId) { setEditingJobKey(null); setJobForm({ ...EMPTY_JOB, storage_ids: storageId ? [storageId] : [] }); setJobErr(null); setShowAddJob(true); }
  function openAddJobWarehouse(name) { setEditingJobKey(null); setJobForm({ ...EMPTY_JOB, warehouses: [name] }); setJobErr(null); setShowAddJob(true); }
  // Warehouse "+ Job": open a small picker first — add an existing job or create a new one.
  function openWarehouseJobPicker(name) { setWhPickerKey(""); setWhPicker({ name }); }
  // Add an already-existing job (by group key) to a warehouse: clone a template part as a new row.
  async function addExistingJobToWarehouse(key, name) {
    const parts = jobs.filter(j => jobKey(j) === key);
    if (!parts.length) { setWhPicker(null); return; }
    if (parts.some(p => p.warehouse === name)) { showToast(`That job is already in ${name}`); setWhPicker(null); return; }
    const tmpl = parts[0];
    // Drop row-specific / server-managed fields; keep all job-level columns intact.
    const { id, storage_id, warehouse, created_at, updated_at, date_out, ...rest } = tmpl;
    const row = { ...rest, storage_id: null, warehouse: name, date_out: null, created_by: userEmail };
    setWhPickerSaving(true);
    const { error } = await supabase.from("storage_jobs").insert([row]);
    setWhPickerSaving(false);
    if (error) { window.alert(error.message); return; }
    setWhPicker(null);
    showToast(`Job ${tmpl.job_number || ""} added to ${name}`.replace(/\s+/g, " ").trim());
    loadJobs();
  }
  // Top-level: open the "add a job to a unit" picker.
  function openUnitJobPicker() { setUjUnitId(""); setUjKey(""); setUnitJobPicker(true); }
  // Attach an existing job to a unit (by group key) — clone a template part as a new row.
  async function addExistingJobToUnit(key, storageId) {
    const parts = jobs.filter(j => jobKey(j) === key);
    if (!parts.length || !storageId) { setUnitJobPicker(false); return; }
    if (parts.some(p => String(p.storage_id) === String(storageId))) { showToast("That job is already in that unit"); setUnitJobPicker(false); return; }
    const tmpl = parts[0];
    const { id, storage_id, warehouse, created_at, updated_at, date_out, ...rest } = tmpl;
    const row = { ...rest, storage_id: Number(storageId), warehouse: null, date_out: null, created_by: userEmail };
    setUjSaving(true);
    const { error } = await supabase.from("storage_jobs").insert([row]);
    setUjSaving(false);
    if (error) { window.alert(error.message); return; }
    setUnitJobPicker(false);
    showToast(`Job ${tmpl.job_number || ""} added to the unit`.replace(/\s+/g, " ").trim());
    loadJobs();
  }
  function openAddJobDate(dateStr) { setEditingJobKey(null); setJobForm({ ...EMPTY_JOB, pickup_date: dateStr, pickup_date_from: dateStr }); setJobErr(null); setShowAddJob(true); }
  // Open the "add existing job to the calendar" search modal, optionally seeded with a day.
  function openCalAddExisting(dateStr) {
    setCalDayMenu(null);
    setCalAddSearch("");
    setCalAddDate(dateStr || today());
    setCalAddExisting({ date: dateStr || "" });
  }
  // Set a job's pickup window (from + optional to) across all of its rows. Empty `from`
  // clears the job off the calendar. `to` is optional.
  async function setJobPickup(ids, from, to) {
    if (!ids?.length) return;
    const patch = {
      pickup_date_from: from || null,
      pickup_date: from || null,
      pickup_date_to: (from && to && to >= from) ? to : null,
      updated_by: userEmail, updated_at: new Date().toISOString(),
    };
    await supabase.from("storage_jobs").update(patch).in("id", ids);
    loadJobs();
  }
  // Add an existing (no-pickup-date) job to the calendar on the chosen date.
  async function addExistingJobToCalendar(g, dateStr) {
    const date = dateStr || today();
    const ids = jobs.filter(j => jobKey(j) === g.key).map(j => j.id);
    await setJobPickup(ids, date, "");
    setCalAddExisting(null);
    showToast(`Job ${g.job_number || ""} added to the calendar`.replace(/\s+/g, " ").trim());
  }
  function openAddJobDeliveryDate(dateStr) { setEditingJobKey(null); setJobForm({ ...EMPTY_JOB, delivery_date: dateStr }); setJobErr(null); setShowAddJob(true); }
  // Open the "add existing job to the delivery calendar" search modal, optionally seeded with a day.
  function openDcalAddExisting(dateStr) {
    setDcalDayMenu(null);
    setDcalAddSearch("");
    setDcalAddDate(dateStr || today());
    setDcalAddExisting({ date: dateStr || "" });
  }
  // Set a job's delivery date across all of its rows. Empty `date` clears the job
  // off the delivery calendar.
  async function setJobDelivery(ids, date) {
    if (!ids?.length) return;
    const patch = { delivery_date: date || null, updated_by: userEmail, updated_at: new Date().toISOString() };
    await supabase.from("storage_jobs").update(patch).in("id", ids);
    loadJobs();
  }
  // Add an existing (no-delivery-date) job to the delivery calendar on the chosen date.
  async function addExistingJobToDeliveryCalendar(g, dateStr) {
    const date = dateStr || today();
    const ids = jobs.filter(j => jobKey(j) === g.key).map(j => j.id);
    await setJobDelivery(ids, date);
    setDcalAddExisting(null);
    showToast(`Job ${g.job_number || ""} added to the delivery calendar`.replace(/\s+/g, " ").trim());
  }
  function showToast(msg) {
    setToast(msg);
    if (toastRef.current) clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 2800);
  }
  // Delete a whole job (all its rows) plus its extras/payments; unlink closing sheets.
  async function deleteJob(g) {
    const ids = (g.parts && g.parts.length ? g.parts.map(p => p.id) : jobs.filter(j => jobKey(j) === g.key).map(j => j.id));
    if (!ids.length) return;
    if (!window.confirm(`Are you sure you want to delete job ${g.job_number || "(no #)"} — ${g.customer || "no client"}? This action cannot be undone.`)) return;
    // Clean up related records first (FKs cascade for extras/billing, but be explicit).
    if (!extrasMissing) await supabase.from("job_extras").delete().in("job_id", ids);
    if (!paymentsMissing) await supabase.from("payments").delete().in("job_id", ids);
    await supabase.from("storage_jobs").update({ closing_sheet_id: null }).in("id", ids);
    const { error } = await supabase.from("storage_jobs").delete().in("id", ids);
    if (error) { window.alert(error.message); return; }
    // Instant UI update, then refresh related data.
    setJobs(prev => prev.filter(j => !ids.includes(j.id)));
    if (jobDetailKey === g.key) setJobDetailKey(null);
    showToast(`Job ${g.job_number || ""} eliminado`.replace(/\s+/g, " ").trim());
    loadJobs();
    if (!extrasMissing) loadExtras();
    if (!paymentsMissing) loadPayments();
    if (!settlementsMissing) loadClosingSheets();
  }
  function openEditJob(jd) {
    setEditingJobKey(jd.key);
    setJobForm({
      storage_ids: [...new Set(jd.parts.filter(p => p.storage_id).map(p => p.storage_id))],
      warehouses: [...new Set(jd.parts.filter(p => p.warehouse).map(p => p.warehouse))],
      driver_ids: Array.isArray(jd.driver_ids) ? jd.driver_ids : [],
      job_number: jd.job_number || "", customer: jd.customer || "", driver: jd.driver || "",
      date_in: jd.date_in || "", fadd: jd.fadd || "", volume: jd.volume || "", real_cf: jd.real_cf ?? "", lot_number: jd.lot_number || "",
      sticker_color: jd.sticker_color || "",
      job_type: jd.job_type || "full", status: jd.status || "scheduled", calendar_status: calStatusOf(jd),
      broker_id: jd.broker_id || "", rep: jd.rep || "", client_phone: jd.client_phone || "", client_email: jd.client_email || "",
      extra_stops: jd.extra_stops || "", price_per_cf: jd.price_per_cf ?? "", fuel_surcharge_pct: jd.fuel_surcharge_pct ?? "", estimate: jd.estimate ?? "", deposit: jd.deposit ?? "",
      carrier_notes: jd.carrier_notes || "",
      pickup_balance: jd.pickup_balance ?? "", delivery_balance: jd.delivery_balance ?? "",
      pickup_date: jd.pickup_date || "", pickup_date_from: jd.pickup_date_from || jd.pickup_date || "", pickup_date_to: jd.pickup_date_to || "", pickup_address: jd.pickup_address || "", pickup_city: jd.pickup_city || "", pickup_state: jd.pickup_state || "", pickup_zip: jd.pickup_zip || "",
      delivery_date: jd.delivery_date || "", delivery_address: jd.delivery_address || "", delivery_city: jd.delivery_city || "", delivery_state: jd.delivery_state || "", delivery_zip: jd.delivery_zip || "",
      billing_active: !!jd.billing_active, client_monthly_rate: jd.client_monthly_rate ?? "", first_month_free: !!jd.first_month_free, billing_start_date: jd.billing_start_date || "",
      closing_sheet_id: jd.closing_sheet_id ?? "", carrier_rate_per_cf: jd.carrier_rate_per_cf ?? "", bol_balance: jd.bol_balance ?? "", bol_collected: jd.bol_collected ?? "", bol_payment_method: jd.bol_payment_method || "", bol_payment_notes: jd.bol_payment_notes || "", bol_collected_date: jd.bol_collected_date || "", pads_received: jd.pads_received ?? "", pads_returned: jd.pads_returned ?? "",
      broker_job_share_pct: jd.broker_job_share_pct ?? "", broker_job_share_enabled: numv(jd.broker_job_share_pct) > 0,
      notes: jd.notes || "",
    });
    setJobErr(null); setJobDetailKey(null); setShowAddJob(true);
  }
  function toggleJobUnit(id) {
    setJobForm(f => ({ ...f, storage_ids: f.storage_ids.includes(id) ? f.storage_ids.filter(x => x !== id) : [...f.storage_ids, id] }));
  }
  function toggleJobWarehouse(name) {
    setJobForm(f => ({ ...f, warehouses: f.warehouses.includes(name) ? f.warehouses.filter(x => x !== name) : [...f.warehouses, name] }));
  }
  async function saveJob() {
    // Storage is optional — a job can be saved with no unit/warehouse (storage_id null).
    if (!jobForm.job_number && !jobForm.customer && !jobForm.driver) { setJobErr("Fill in at least job, client or driver."); return; }
    setJobSaving(true); setJobErr(null);
    const fields = {
      job_number: jobForm.job_number || null,
      customer: jobForm.customer || null,
      driver: jobForm.driver || null,
      date_in: jobForm.date_in || today(),
      volume: jobForm.volume || null,
      ...(realCfMissing ? {} : { real_cf: jobForm.real_cf !== "" && jobForm.real_cf != null ? Number(jobForm.real_cf) : null }),
      lot_number: jobForm.lot_number || null,
      sticker_color: jobForm.sticker_color || null,
      delivery_address: jobForm.delivery_address || null,
      delivery_state: jobForm.delivery_state || null,
      delivery_zip: jobForm.delivery_zip || null,
      notes: jobForm.notes || null,
    };
    if (!faddColMissing) fields.fadd = jobForm.fadd || null;
    // Calendar colour: explicit, manual-only field. Never inferred from status.
    if (!calStatusMissing) fields.calendar_status = jobForm.calendar_status || "active";
    if (!jobColsMissing) {
      fields.job_type = jobForm.job_type || null;
      fields.status = jobForm.status || "scheduled";
      // Keep the legacy single pickup_date in sync with the range's start.
      fields.pickup_date = jobForm.pickup_date_from || jobForm.pickup_date || null;
      fields.pickup_address = jobForm.pickup_address || null;
      fields.pickup_city = jobForm.pickup_city || null;
      fields.pickup_state = jobForm.pickup_state || null;
      fields.pickup_zip = jobForm.pickup_zip || null;
      fields.delivery_date = jobForm.delivery_date || null;
      fields.delivery_city = jobForm.delivery_city || null;
    }
    if (!crmV2Missing) {
      fields.broker_id = jobForm.broker_id ? Number(jobForm.broker_id) : null;
      fields.pickup_balance = jobForm.pickup_balance !== "" ? Number(jobForm.pickup_balance) : null;
      fields.delivery_balance = jobForm.delivery_balance !== "" ? Number(jobForm.delivery_balance) : null;
    }
    if (!billingMissing) {
      fields.billing_active = !!jobForm.billing_active;
      fields.client_monthly_rate = jobForm.client_monthly_rate !== "" ? Number(jobForm.client_monthly_rate) : null;
      fields.first_month_free = !!jobForm.first_month_free;
      // Auto-calc billing start: first_month_free → date_in + 30, else date_in. Editable.
      const di = jobForm.date_in || today();
      fields.billing_start_date = jobForm.billing_start_date || (jobForm.first_month_free ? addDaysStr(di, 30) : di);
    }
    if (!crmV3Missing) {
      fields.rep = jobForm.rep || null;
      fields.client_phone = jobForm.client_phone || null;
      fields.client_email = jobForm.client_email || null;
      fields.extra_stops = jobForm.extra_stops || null;
      fields.carrier_notes = jobForm.carrier_notes || null;
      fields.price_per_cf = jobForm.price_per_cf !== "" ? Number(jobForm.price_per_cf) : null;
      fields.fuel_surcharge_pct = jobForm.fuel_surcharge_pct !== "" ? Number(jobForm.fuel_surcharge_pct) : null;
      fields.estimate = jobForm.estimate !== "" ? Number(jobForm.estimate) : null;
      fields.deposit = jobForm.deposit !== "" ? Number(jobForm.deposit) : null;
      fields.pickup_date_from = jobForm.pickup_date_from || null;
      fields.pickup_date_to = jobForm.pickup_date_to || null;
      const ids = Array.isArray(jobForm.driver_ids) ? jobForm.driver_ids.map(Number) : [];
      fields.driver_ids = ids;
      // Mirror driver names into the legacy text field for display/search/back-compat.
      const names = ids.map(id => driversList.find(d => d.id === id)?.name).filter(Boolean);
      if (names.length) fields.driver = names.join(", ");
    }
    if (!settlementsMissing) {
      // Resolve the closing sheet link: "__new__" creates a fresh open sheet for this broker.
      let csId = null;
      if (jobForm.closing_sheet_id === "__new__") {
        const { data } = await supabase.from("closing_sheets").insert([{ broker_id: jobForm.broker_id ? Number(jobForm.broker_id) : null, load_date: today(), status: "open" }]).select("id").single();
        csId = data?.id || null;
      } else if (jobForm.closing_sheet_id !== "" && jobForm.closing_sheet_id != null) {
        csId = Number(jobForm.closing_sheet_id);
      }
      fields.closing_sheet_id = csId;
      fields.carrier_rate_per_cf = jobForm.carrier_rate_per_cf !== "" ? Number(jobForm.carrier_rate_per_cf) : null;
      fields.bol_balance = jobForm.bol_balance !== "" ? Number(jobForm.bol_balance) : null;
      fields.bol_collected = jobForm.bol_collected !== "" ? Number(jobForm.bol_collected) : 0;
      fields.bol_payment_method = jobForm.bol_payment_method || null;
      fields.bol_payment_notes = jobForm.bol_payment_notes || null;
      fields.bol_collected_date = jobForm.bol_collected_date || null;
      fields.pads_received = jobForm.pads_received !== "" ? parseInt(jobForm.pads_received) : 0;
      fields.pads_returned = jobForm.pads_returned !== "" ? parseInt(jobForm.pads_returned) : 0;
    }
    if (!brokerShareMissing) {
      const bjPct = jobForm.broker_job_share_pct !== "" ? Number(jobForm.broker_job_share_pct) : 0;
      const collected = numv(jobForm.bol_collected) || (numv(jobForm.pickup_balance) + numv(jobForm.delivery_balance));
      fields.broker_job_share_pct = bjPct;
      fields.broker_job_share_amount = collected * bjPct / 100;
    }

    const hasLoc = jobForm.storage_ids.length > 0 || jobForm.warehouses.length > 0;
    if (editingJobKey) {
      const current = jobs.filter(j => jobKey(j) === editingJobKey);
      const created = { ...fields, created_by: userEmail };
      let error = null;
      // Update job-level fields on every existing part first.
      if (current.length) ({ error } = await supabase.from("storage_jobs").update({ ...fields, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", current.map(p => p.id)));
      if (!error) {
        if (!hasLoc) {
          // No storage selected: collapse the job to a single unassigned row.
          if (current.length) {
            await supabase.from("storage_jobs").update({ storage_id: null, warehouse: null }).eq("id", current[0].id);
            const rest = current.slice(1).map(p => p.id);
            if (rest.length) ({ error } = await supabase.from("storage_jobs").delete().in("id", rest));
          } else {
            ({ error } = await supabase.from("storage_jobs").insert([{ ...created, storage_id: null, warehouse: null }]));
          }
        } else {
          // Reconcile selected units/warehouses against existing parts.
          const desiredUnits = new Set(jobForm.storage_ids);
          const desiredWhs = new Set(jobForm.warehouses);
          const toDelete = [], keptUnits = new Set(), keptWhs = new Set();
          for (const p of current) {
            if (p.storage_id) { desiredUnits.has(p.storage_id) ? keptUnits.add(p.storage_id) : toDelete.push(p.id); }
            else if (p.warehouse) { desiredWhs.has(p.warehouse) ? keptWhs.add(p.warehouse) : toDelete.push(p.id); }
            else toDelete.push(p.id); // drop a prior unassigned placeholder now that real locations exist
          }
          const newRows = [
            ...jobForm.storage_ids.filter(id => !keptUnits.has(id)).map(sid => ({ ...created, storage_id: sid, warehouse: null })),
            ...jobForm.warehouses.filter(w => !keptWhs.has(w)).map(w => ({ ...created, storage_id: null, warehouse: w })),
          ];
          if (toDelete.length) ({ error } = await supabase.from("storage_jobs").delete().in("id", toDelete));
          if (!error && newRows.length) ({ error } = await supabase.from("storage_jobs").insert(newRows));
        }
      }
      setJobSaving(false);
      if (error) { setJobErr(error.message); return; }
    } else {
      const created = { ...fields, created_by: userEmail };
      const rows = hasLoc ? [
        ...jobForm.storage_ids.map(sid => ({ ...created, storage_id: sid, warehouse: null })),
        ...jobForm.warehouses.map(w => ({ ...created, storage_id: null, warehouse: w })),
      ] : [{ ...created, storage_id: null, warehouse: null }];
      const { error } = await supabase.from("storage_jobs").insert(rows);
      setJobSaving(false);
      if (error) { setJobErr(error.message); return; }
    }
    setShowAddJob(false);
    loadJobs();
    if (!settlementsMissing) loadClosingSheets();
  }

  // Advance a job to its next status across all its parts. Reaching "delivered"
  // also stamps date_out (so it leaves the active lists). Falls back to the
  // delivered flag when the CRM status columns aren't present yet.
  async function advanceStatus(g) {
    if (!g?.parts?.length) return;
    if (jobColsMissing) { await deliverJobs(g.parts.map(p => p.id)); return; }
    const ns = nextStatus(g);
    if (!ns) return;
    const patch = { status: ns, updated_by: userEmail, updated_at: new Date().toISOString() };
    if (ns === "delivered") patch.date_out = today();
    if (ns === "picked_up" && !g.pickup_date) patch.pickup_date = today();
    await supabase.from("storage_jobs").update(patch).in("id", g.parts.map(p => p.id));
    loadJobs();
  }

  // ── Brokers CRUD ──
  function openAddBroker() { setEditingBrokerId(null); setBrokerForm(EMPTY_BROKER); setShowBrokerModal(true); }
  function openEditBroker(b) {
    setEditingBrokerId(b.id);
    setBrokerForm({ name:b.name||"", contact_name:b.contact_name||"", contact_phone:b.contact_phone||"", contact_email:b.contact_email||"", notes:b.notes||"" });
    setShowBrokerModal(true);
  }
  async function saveBroker() {
    if (!brokerForm.name.trim()) return;
    setBrokerSaving(true);
    const payload = { name:brokerForm.name.trim(), contact_name:brokerForm.contact_name||null, contact_phone:brokerForm.contact_phone||null, contact_email:brokerForm.contact_email||null, notes:brokerForm.notes||null };
    if (editingBrokerId) await supabase.from("brokers").update(payload).eq("id", editingBrokerId);
    else await supabase.from("brokers").insert([payload]);
    setBrokerSaving(false); setShowBrokerModal(false);
    loadBrokers();
  }
  async function deleteBroker(b) {
    if (!window.confirm(`Delete broker "${b.name}"? Los jobs asociados quedan sin broker.`)) return;
    await supabase.from("brokers").delete().eq("id", b.id);
    loadBrokers();
  }

  // ── Drivers CRUD ──
  function openAddDriver() { setEditingDriverId(null); setDriverForm(EMPTY_DRIVER); setShowDriverModal(true); }
  function openEditDriver(d) {
    setEditingDriverId(d.id);
    setDriverForm({ name:d.name||"", phone:d.phone||"", whatsapp_group_link:d.whatsapp_group_link||"", truck_id:d.truck_id||"", notes:d.notes||"", active: d.active !== false });
    setShowDriverModal(true);
  }
  async function saveDriver() {
    if (!driverForm.name.trim()) return;
    setDriverSaving(true);
    const payload = { name:driverForm.name.trim(), phone:driverForm.phone||null, whatsapp_group_link:driverForm.whatsapp_group_link||null, truck_id:driverForm.truck_id||null, notes:driverForm.notes||null, active: !!driverForm.active };
    if (editingDriverId) await supabase.from("drivers").update(payload).eq("id", editingDriverId);
    else await supabase.from("drivers").insert([payload]);
    setDriverSaving(false); setShowDriverModal(false);
    loadDrivers();
  }
  async function deleteDriver(d) {
    if (!window.confirm(`Delete driver "${d.name}"?`)) return;
    await supabase.from("drivers").delete().eq("id", d.id);
    loadDrivers();
  }
  function toggleJobDriver(id) {
    setJobForm(f => { const cur = Array.isArray(f.driver_ids) ? f.driver_ids : []; return { ...f, driver_ids: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }; });
  }

  // ── Carrier settlements handlers ──
  function openAddCs() {
    setEditingCsId(null); setCsForm(EMPTY_CS); setCsJobSearch(""); setShowCsModal(true);
  }
  function openEditCs(s) {
    setEditingCsId(s.id);
    const assigned = [...new Set(jobs.filter(j => j.closing_sheet_id === s.id).map(jobKey))];
    setCsForm({
      closing_sheet_number: s.closing_sheet_number || "", broker_id: s.broker_id || "", driver_id: s.driver_id || "",
      load_date: s.load_date || "", status: s.status || "open",
      charge_per_pad: s.charge_per_pad ?? "7",
      trip_cost: s.trip_cost ?? "", labor_charges: s.labor_charges ?? "", other_fees: s.other_fees ?? "", other_fees_description: s.other_fees_description || "",
      notes: s.notes || "", document_url: s.document_url || "", job_keys: assigned,
    });
    setCsJobSearch(""); setShowCsModal(true);
  }
  function csToggleJob(k) {
    setCsForm(f => ({ ...f, job_keys: f.job_keys.includes(k) ? f.job_keys.filter(x => x !== k) : [...f.job_keys, k] }));
  }
  async function saveCs() {
    setCsSaving(true);
    const payload = {
      closing_sheet_number: csForm.closing_sheet_number || null,
      broker_id: csForm.broker_id ? Number(csForm.broker_id) : null,
      driver_id: csForm.driver_id ? Number(csForm.driver_id) : null,
      load_date: csForm.load_date || null,
      status: csForm.status || "open",
      charge_per_pad: csForm.charge_per_pad !== "" ? Number(csForm.charge_per_pad) : 7,
      trip_cost: csForm.trip_cost !== "" ? Number(csForm.trip_cost) : 0,
      labor_charges: csForm.labor_charges !== "" ? Number(csForm.labor_charges) : 0,
      other_fees: csForm.other_fees !== "" ? Number(csForm.other_fees) : 0,
      other_fees_description: csForm.other_fees_description || null,
      notes: csForm.notes || null,
      document_url: csForm.document_url || null,
    };
    let sheetId = editingCsId;
    let error = null;
    if (editingCsId) {
      ({ error } = await supabase.from("closing_sheets").update(payload).eq("id", editingCsId));
    } else {
      const { data, error: insErr } = await supabase.from("closing_sheets").insert([payload]).select("id").single();
      error = insErr; sheetId = data?.id;
    }
    if (!error && sheetId) {
      // Reconcile job assignment: set closing_sheet_id on selected jobs, clear de-selected.
      const wanted = new Set(csForm.job_keys);
      const toSet = jobs.filter(j => wanted.has(jobKey(j)) && j.closing_sheet_id !== sheetId).map(j => j.id);
      const toClear = jobs.filter(j => j.closing_sheet_id === sheetId && !wanted.has(jobKey(j))).map(j => j.id);
      if (toSet.length) await supabase.from("storage_jobs").update({ closing_sheet_id: sheetId, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", toSet);
      if (toClear.length) await supabase.from("storage_jobs").update({ closing_sheet_id: null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", toClear);
    }
    setCsSaving(false);
    if (error) { window.alert(error.message); return; }
    setShowCsModal(false);
    loadClosingSheets(); loadJobs();
    if (sheetId && !editingCsId) setCsDetailId(sheetId);
  }
  async function setCsStatus(s, status) {
    await supabase.from("closing_sheets").update({ status }).eq("id", s.id);
    loadClosingSheets();
  }
  async function deleteCs(s) {
    if (!window.confirm(`Delete closing sheet #${s.closing_sheet_number || s.id}? Jobs are left unassigned.`)) return;
    await supabase.from("storage_jobs").update({ closing_sheet_id: null }).eq("closing_sheet_id", s.id);
    await supabase.from("closing_sheets").delete().eq("id", s.id);
    setCsDetailId(null); loadClosingSheets(); loadJobs();
  }
  // Inline-edit a per-job settlement field (carrier_rate_per_cf, bol_balance, volume) on all its parts.
  async function updateJobBol(jobKeyStr, field, value) {
    const ids = jobs.filter(j => jobKey(j) === jobKeyStr).map(j => j.id);
    if (!ids.length) return;
    await supabase.from("storage_jobs").update({ [field]: value === "" ? null : value, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    loadJobs();
  }
  // Create a fresh open closing sheet for a job's broker and link the job to it.
  async function addJobToNewSheet(jobKeyStr, brokerId) {
    const { data } = await supabase.from("closing_sheets").insert([{ broker_id: brokerId || null, load_date: today(), status: "open" }]).select("id").single();
    if (data?.id) { await updateJobBol(jobKeyStr, "closing_sheet_id", data.id); loadClosingSheets(); }
  }

  // ── Trucks CRUD ──
  function openAddTruck() { setEditingTruckId(null); setTruckForm(EMPTY_TRUCK); setShowTruckModal(true); }
  function openEditTruck(t) {
    setEditingTruckId(t.id);
    setTruckForm({ name:t.name||"", plate:t.plate||"", capacity_cf:t.capacity_cf ?? "", notes:t.notes||"", active: t.active !== false,
      year: t.year ?? "", make: t.make || "", model: t.model || "", vin: t.vin || "", license_plate: t.license_plate || "", license_state: t.license_state || "" });
    setShowTruckModal(true);
  }
  async function saveTruck() {
    if (!truckForm.name.trim()) return;
    setTruckSaving(true);
    const payload = { name:truckForm.name.trim(), plate:truckForm.plate||null, capacity_cf: truckForm.capacity_cf !== "" ? Number(truckForm.capacity_cf) : null, notes:truckForm.notes||null, active: !!truckForm.active };
    if (!truckColsMissing) {
      payload.year = truckForm.year !== "" ? parseInt(truckForm.year) : null;
      payload.make = truckForm.make || null;
      payload.model = truckForm.model || null;
      payload.vin = truckForm.vin ? truckForm.vin.toUpperCase().slice(0, 17) : null;
      payload.license_plate = truckForm.license_plate || null;
      payload.license_state = truckForm.license_state || null;
    }
    let error = null;
    if (editingTruckId) ({ error } = await supabase.from("trucks").update(payload).eq("id", editingTruckId));
    else ({ error } = await supabase.from("trucks").insert([payload]));
    setTruckSaving(false);
    if (error) { window.alert(error.message); return; }
    setShowTruckModal(false); loadTrucks();
  }
  async function deleteTruck(t) {
    if (!window.confirm(`Delete truck "${t.name}"?`)) return;
    await supabase.from("trucks").delete().eq("id", t.id); loadTrucks();
  }

  // ── Live-load: set a truck's manual / last-known position ──
  function openLocModal(t) {
    setLocErr(null);
    setLocForm({ query:"", lat: t.last_lat ?? "", lng: t.last_lng ?? "", label: t.last_location || "", status: t.last_status || "stopped" });
    setLocModal(t);
  }
  // Geocode the typed address via the serverless proxy and fill lat/lng/label.
  async function geocodeLoc() {
    const q = locForm.query.trim();
    if (!q) { setLocErr("Type an address to search."); return; }
    setLocBusy(true); setLocErr(null);
    try {
      const r = await fetch("/api/geocode?q=" + encodeURIComponent(q));
      const data = await r.json();
      if (!r.ok) { setLocErr(data?.error || "Could not geocode."); }
      else setLocForm(f => ({ ...f, lat: data.lat, lng: data.lng, label: data.label }));
    } catch (e) { setLocErr("Could not connect to the geocoder."); }
    setLocBusy(false);
  }
  async function saveLoc() {
    const lat = parseFloat(locForm.lat), lng = parseFloat(locForm.lng);
    if (isNaN(lat) || isNaN(lng)) { setLocErr("Missing coordinates (search an address or enter lat/lng)."); return; }
    setLocBusy(true); setLocErr(null);
    const payload = { last_lat: lat, last_lng: lng, last_location: locForm.label || null, last_status: locForm.status || null, last_location_at: new Date().toISOString() };
    const { error } = await supabase.from("trucks").update(payload).eq("id", locModal.id);
    setLocBusy(false);
    if (error) { setLocErr(error.message); return; }
    setLocModal(null);
    showToast(`Location updated · ${locModal.name}`);
    loadTrucks();
  }

  // ── Legal & Compliance handlers ──
  function openAddCompany() { setEditingCompanyId(null); setCompanyForm(EMPTY_COMPANY); setShowCompanyModal(true); }
  function openEditCompany(c) {
    setEditingCompanyId(c.id);
    setCompanyForm({ name:c.name||"", dot_number:c.dot_number||"", mc_number:c.mc_number||"", ein:c.ein||"", state:c.state||"", address:c.address||"", phone:c.phone||"", email:c.email||"", active: c.active !== false, notes:c.notes||"" });
    setShowCompanyModal(true);
  }
  async function saveCompany() {
    if (!companyForm.name.trim()) return;
    setCompanySaving(true);
    const payload = { name:companyForm.name.trim(), dot_number:companyForm.dot_number||null, mc_number:companyForm.mc_number||null, ein:companyForm.ein||null, state:companyForm.state||null, address:companyForm.address||null, phone:companyForm.phone||null, email:companyForm.email||null, active: !!companyForm.active, notes:companyForm.notes||null };
    let error = null;
    if (editingCompanyId) ({ error } = await supabase.from("companies").update(payload).eq("id", editingCompanyId));
    else ({ error } = await supabase.from("companies").insert([payload]));
    setCompanySaving(false);
    if (error) { window.alert(error.message); return; }
    setShowCompanyModal(false); loadCompanies();
  }
  async function deleteCompany(c) {
    if (!window.confirm(`Delete company "${c.name}" y todos sus documentos?`)) return;
    await supabase.from("compliance_documents").delete().eq("entity_type", "company").eq("entity_id", c.id);
    await supabase.from("companies").delete().eq("id", c.id);
    loadCompanies(); loadComplianceDocs();
  }
  function openAddDoc(prefill = {}) {
    setEditingDocId(null);
    setDocForm({ ...EMPTY_COMP_DOC, ...prefill });
    setShowDocModal(true);
  }
  function openEditDoc(d) {
    setEditingDocId(d.id);
    setDocForm({ entity_type:d.entity_type||"company", entity_id:d.entity_id||"", document_type:d.document_type||"other", document_name:d.document_name||"", document_number:d.document_number||"", issuer:d.issuer||"", issue_date:d.issue_date||"", expiry_date:d.expiry_date||"", document_url:d.document_url||"", notes:d.notes||"" });
    setShowDocModal(true);
  }
  async function saveDoc() {
    if (!docForm.entity_id) { window.alert("Choose who the document belongs to."); return; }
    setDocSaving(true);
    const payload = {
      entity_type: docForm.entity_type, entity_id: Number(docForm.entity_id),
      document_type: docForm.document_type, document_name: docForm.document_name || null,
      document_number: docForm.document_number || null, issuer: docForm.issuer || null,
      issue_date: docForm.issue_date || null, expiry_date: docForm.expiry_date || null,
      status: docStatus(docForm), document_url: docForm.document_url || null, notes: docForm.notes || null,
    };
    let error = null;
    if (editingDocId) ({ error } = await supabase.from("compliance_documents").update(payload).eq("id", editingDocId));
    else ({ error } = await supabase.from("compliance_documents").insert([payload]));
    setDocSaving(false);
    if (error) { window.alert(error.message); return; }
    setShowDocModal(false); loadComplianceDocs();
  }
  async function deleteDoc(d) {
    if (!window.confirm(`Delete document "${docTypeLabel(d.document_type)}"?`)) return;
    await supabase.from("compliance_documents").delete().eq("id", d.id); loadComplianceDocs();
  }
  // Upload a photo/PDF to the compliance-docs bucket. If `doc` has an id, attach to it;
  // otherwise stash the URL in the open doc form.
  async function uploadComplianceDoc(file, doc) {
    if (!file) return;
    setCompDocUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      const path = `comp-${doc?.id || "new"}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("compliance-docs").upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (error) { window.alert("Upload error: " + error.message); setCompDocUploading(false); return; }
      const { data } = supabase.storage.from("compliance-docs").getPublicUrl(path);
      const url = data?.publicUrl || "";
      if (doc?.id) { await supabase.from("compliance_documents").update({ document_url: url }).eq("id", doc.id); loadComplianceDocs(); }
      else { setDocForm(f => ({ ...f, document_url: url })); }
    } catch (e) { window.alert("Error: " + e.message); }
    setCompDocUploading(false);
  }
  // Drop a file onto an empty grid cell → create the doc record then attach the file.
  async function createDocAndUpload(entity_type, entity_id, document_type, file) {
    if (!file) return;
    const { data, error } = await supabase.from("compliance_documents")
      .insert([{ entity_type, entity_id: Number(entity_id), document_type, document_name: docTypeLabel(document_type), status: "none" }])
      .select("id").single();
    if (error) { window.alert(error.message); return; }
    if (data?.id) await uploadComplianceDoc(file, { id: data.id });
    loadComplianceDocs();
  }

  // ── Trips CRUD ──
  function nextTripNumber() {
    let max = 0;
    for (const t of trips) { const m = (t.trip_number || "").match(/(\d+)/); if (m) max = Math.max(max, parseInt(m[1])); }
    return "TRIP-" + String(max + 1).padStart(3, "0");
  }
  function openAddTrip() {
    setEditingTripId(null);
    setTripForm({ ...EMPTY_TRIP, trip_number: nextTripNumber(), departure_date: today() });
    setTripJobSearch(""); setShowTripModal(true);
  }
  function openEditTrip(t) {
    setEditingTripId(t.id);
    const assignedJobs = jobsByTrip[t.id] || [];
    const assigned = assignedJobs.map(tripUnitKey);
    const purposes = {};
    for (const j of assignedJobs) { if (isRelocation(j)) purposes[tripUnitKey(j)] = "relocation"; }
    setTripForm({ trip_number:t.trip_number||"", truck_id:t.truck_id||"", driver_id:t.driver_id||"", departure_date:t.departure_date||"", status:t.status||"loading", notes:t.notes||"", job_keys: assigned, purposes });
    setTripJobSearch(""); setShowTripModal(true);
  }
  // ── AI trip suggestions ──────────────────────────────────────────────
  // Ask Claude (via /api/trip-suggestions) to group the candidate jobs into
  // new trips for free trucks and top-ups of trips still loading. Suggestions
  // are review-only: accepting one just prefills the normal trip modal.
  async function requestTripSuggestions() {
    if (tripAILoading) return;
    if (!tripCandidateJobs.length) { window.alert(trAI("No jobs available to group.", "No hay jobs disponibles para agrupar.")); return; }
    if (!freeTrucks.length && !loadingTripsWithRoom.length) { window.alert(trAI("No free trucks or loading trips with room.", "No hay camiones libres ni trips cargando con capacidad.")); return; }
    // Oldest FADD first so, if the list is capped, the least urgent jobs drop.
    const sorted = [...tripCandidateJobs].sort((a, b) => (a.fadd || "9999").localeCompare(b.fadd || "9999"));
    const payload = {
      today: today(),
      lang, // the AI writes reasoning/notes in the user's display language
      jobs: sorted.slice(0, 150).map(j => ({
        key: tripUnitKey(j),
        job_number: j.job_number || "",
        customer: j.customer || "",
        volume_cf: Math.round(effCf(j)),
        split: !!j.split_group,
        fadd: j.fadd || "",
        status: j.status || "",
        // Load point with its real location: the customer's own pickup address,
        // or the storage unit / warehouse where the job is stored — so the AI
        // can judge whether picking it up fits the trip's route, not just the delivery.
        origin: (() => {
          const o = jobOrigin(j, storageById);
          if (!o) return "";
          if (o.kind === "pickup") return "Customer pickup at: " + (o.query || "unknown address");
          if (o.kind === "storage") return `Storage unit "${o.label}" at: ${o.query || "unknown location"}`;
          return o.label; // company warehouse — "Warehouse Indiana" / "Warehouse New Jersey"
        })(),
        delivery: [j.delivery_city, j.delivery_state, j.delivery_zip].filter(Boolean).join(", "),
        delivery_state: j.delivery_state || "",
      })),
      trucks: freeTrucks.map(tk => ({ id: tk.id, name: tk.name || "", capacity_cf: numv(tk.capacity_cf) })),
      loading_trips: loadingTripsWithRoom,
    };
    setShowTripAI(true); setTripAILoading(true); setTripAIError(null);
    try {
      const res = await fetch("/api/trip-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) setTripAIError(data.error || trAI("Could not connect to the AI.", "No se pudo conectar con la IA."));
      else setTripAIResult(data);
    } catch {
      setTripAIError(trAI("Error connecting to the AI. Try again.", "Error conectando con la IA. Intentá de nuevo."));
    }
    setTripAILoading(false);
  }
  // Accepting a suggestion never writes directly: it prefills the existing trip
  // modal (create or edit) so the dispatcher picks the driver, reviews the live
  // capacity bar and confirms through saveTrip() as always.
  function applyTripSuggestion(s, kind) {
    const live = new Set(tripCandidateJobs.map(tripUnitKey));
    const valid = s.job_keys.filter(k => live.has(k));
    if (!valid.length) { window.alert(trAI("The jobs in this suggestion are no longer available.", "Los jobs de esta sugerencia ya no están disponibles.")); return; }
    if (valid.length < s.job_keys.length && !window.confirm(trAI(
      `${s.job_keys.length - valid.length} job(s) are no longer available and will be skipped. Continue?`,
      `${s.job_keys.length - valid.length} job(s) ya no están disponibles y se omitirán. ¿Continuar?`))) return;
    if (kind === "addition") {
      const t = trips.find(x => x.id === s.trip_id);
      if (!t || t.status !== "loading") { window.alert(trAI("That trip is no longer in Loading status.", "Ese trip ya no está en estado Loading.")); return; }
      setEditingTripId(t.id);
      const tripPurposes = {};
      for (const j of (jobsByTrip[t.id] || [])) { if (isRelocation(j)) tripPurposes[tripUnitKey(j)] = "relocation"; }
      setTripForm({
        trip_number: t.trip_number || "", truck_id: t.truck_id || "", driver_id: t.driver_id || "",
        departure_date: t.departure_date || "", status: t.status || "loading", notes: t.notes || "",
        job_keys: [...(jobsByTrip[t.id] || []).map(tripUnitKey), ...valid.filter(k => !(jobsByTrip[t.id] || []).some(j => tripUnitKey(j) === k))],
        purposes: tripPurposes,
      });
    } else {
      setEditingTripId(null);
      setTripForm({
        ...EMPTY_TRIP, trip_number: nextTripNumber(), departure_date: today(),
        truck_id: String(s.truck_id), job_keys: valid,
        notes: s.reasoning ? ("IA: " + s.reasoning).slice(0, 200) : "",
      });
    }
    setTripJobSearch(""); setShowTripAI(false); setShowTripModal(true);
  }
  function tripToggleJob(k) {
    setTripForm(f => ({ ...f, job_keys: f.job_keys.includes(k) ? f.job_keys.filter(x => x !== k) : [...f.job_keys, k] }));
  }
  function tripMoveJob(idx, dir) {
    setTripForm(f => {
      const arr = [...f.job_keys]; const ni = idx + dir;
      if (ni < 0 || ni >= arr.length) return f;
      [arr[idx], arr[ni]] = [arr[ni], arr[idx]];
      return { ...f, job_keys: arr };
    });
  }
  async function saveTrip() {
    setTripSaving(true);
    // NOTE: status is deliberately NOT part of the edit payload. Trip status only
    // ever changes through the explicit buttons (setTripStatus / completeTrip).
    // A new trip always starts as "loading".
    const payload = {
      trip_number: tripForm.trip_number || null,
      truck_id: tripForm.truck_id ? Number(tripForm.truck_id) : null,
      driver_id: tripForm.driver_id ? Number(tripForm.driver_id) : null,
      departure_date: tripForm.departure_date || null,
      notes: tripForm.notes || null,
    };
    let tripId = editingTripId, error = null;
    if (editingTripId) ({ error } = await supabase.from("trips").update(payload).eq("id", editingTripId));
    else { const { data, error: insErr } = await supabase.from("trips").insert([{ ...payload, status: "loading" }]).select("id").single(); error = insErr; tripId = data?.id; }
    if (!error && tripId) {
      const wanted = tripForm.job_keys;
      // Assign trip_id + stop order in the chosen sequence; clear de-selected jobs.
      // Keys are trip-unit keys: "row:<id>" for a split portion, jobKey otherwise.
      for (let i = 0; i < wanted.length; i++) {
        const ids = jobRowIdsForUnit(wanted[i]);
        const purpose = tripPurposeColMissing ? {} : { trip_purpose: tripForm.purposes?.[wanted[i]] === "relocation" ? "relocation" : "delivery" };
        if (ids.length) await supabase.from("storage_jobs").update({ trip_id: tripId, trip_stop_order: i + 1, ...purpose, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
      }
      const wantedSet = new Set(wanted);
      const toClear = jobs.filter(j => j.trip_id === tripId && !wantedSet.has(tripUnitKey(j))).map(j => j.id);
      if (toClear.length) await supabase.from("storage_jobs").update({ trip_id: null, trip_stop_order: null, ...(tripPurposeColMissing ? {} : { trip_purpose: null }), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", toClear);
    }
    setTripSaving(false);
    if (error) { window.alert(error.message); return; }
    setShowTripModal(false); loadTrips(); loadJobs();
  }
  // Manual trip status change — always dispatcher-initiated and confirmed.
  async function setTripStatus(t, status) {
    const label = (TRIP_STATUS[status]?.l) || status;
    if (!window.confirm(`Change the status of trip ${t.trip_number || "#"+t.id} to "${label}"?`)) return;
    await supabase.from("trips").update({ status }).eq("id", t.id); loadTrips();
  }
  // Manual trip status change from the edit form — applies immediately on button
  // click (no confirm) and persists to Supabase. The ONLY automatic rule is that
  // a brand-new trip is created as "loading"; nothing else ever changes status.
  async function setEditTripStatus(status) {
    if (!editingTripId) return;
    setTripForm(f => ({ ...f, status }));
    await supabase.from("trips").update({ status }).eq("id", editingTripId);
    loadTrips();
  }
  async function deleteTrip(t) {
    if (!window.confirm(`Delete trip ${t.trip_number || t.id}? Jobs are left without a trip.`)) return;
    await supabase.from("storage_jobs").update({ trip_id: null, trip_stop_order: null, ...(tripPurposeColMissing ? {} : { trip_purpose: null }) }).eq("trip_id", t.id);
    await supabase.from("trips").delete().eq("id", t.id);
    loadTrips(); loadJobs();
  }
  // Persist a new stop order for a trip (array of jobKeys in the desired sequence).
  // Renumber a trip's full sequence (jobs + custom stops) into one 1..N order.
  async function persistUnifiedOrder(trip, orderedItems) {
    for (let i = 0; i < orderedItems.length; i++) {
      const it = orderedItems[i];
      if (it.kind === "job") {
        const ids = jobRowIdsForUnit(tripUnitKey(it.j));
        if (ids.length) await supabase.from("storage_jobs").update({ trip_stop_order: i + 1 }).in("id", ids);
      } else {
        await supabase.from("trip_stops").update({ stop_order: i + 1 }).eq("id", it.s.id);
      }
    }
    loadJobs(); loadTripStops();
  }
  // ── Custom (non-job) stops: maintenance, DOT inspection, fuel, etc. ──
  function openAddStop(trip) {
    setStopForm({ category:"maintenance", address:"", note:"" });
    setAddStopModal({ trip });
  }
  // Edit an existing custom stop (category / address / note).
  function openEditStop(trip, s) {
    setStopForm({ category: s.category || "other", address: s.address || "", note: s.note || "" });
    setAddStopModal({ trip, editId: s.id });
  }
  async function saveCustomStop() {
    const trip = addStopModal?.trip;
    if (!trip) return;
    setStopSaving(true);
    const fields = {
      category: stopForm.category,
      address: stopForm.address.trim() || null,
      note: stopForm.note.trim() || null,
    };
    let error;
    if (addStopModal.editId) {
      ({ error } = await supabase.from("trip_stops").update(fields).eq("id", addStopModal.editId));
    } else {
      // Append at the very end of the unified sequence (after jobs + custom stops).
      // Use max existing order + 1 so it lands last even if orders have gaps.
      const seq = tripSequenceByTrip[trip.id] || [];
      const order = (seq.length ? Math.max(...seq.map(it => it.order || 0)) : 0) + 1;
      ({ error } = await supabase.from("trip_stops").insert([{ trip_id: trip.id, ...fields, stop_order: order, created_by: userEmail }]));
    }
    setStopSaving(false);
    if (error) { window.alert(error.message); return; }
    const wasEdit = !!addStopModal.editId;
    setAddStopModal(null);
    loadTripStops();
    if (!wasEdit) logTripEvent(trip.id, "custom_stop_added", { notes: `${catLabel(stopForm.category)}${stopForm.address ? ` · ${stopForm.address}` : ""}` });
  }
  async function toggleCustomStop(s) {
    await supabase.from("trip_stops").update({ done: !s.done }).eq("id", s.id);
    loadTripStops();
  }
  async function deleteCustomStop(s) {
    if (!window.confirm(trAI(`Delete the "${catLabel(s.category)}" stop?`, `¿Eliminar la parada "${catLabel(s.category)}"?`))) return;
    await supabase.from("trip_stops").delete().eq("id", s.id);
    loadTripStops();
  }
  // Mark one trip job delivered. A split portion delivers on its own (only its
  // row) so a sibling portion on another truck stays in transit; an ordinary job
  // still stamps all its unit rows together.
  async function tripMarkDelivered(j, trip) {
    const ids = jobRowIdsForUnit(tripUnitKey(j));
    await supabase.from("storage_jobs").update({ date_out: today(), status: "delivered", updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    if (trip) await logTripEvent(trip.id, "delivery_completed", { job_id: Math.min(...ids), notes: j.job_number || "" });
    loadJobs();
  }

  // ── Dynamic in-transit trip changes ──
  // All storage_jobs row ids that make up a job (by jobKey).
  const jobRowIds = (k) => jobs.filter(j => jobKey(j) === k).map(j => j.id);
  // Row ids for a trip-unit key: a single portion row for "row:<id>" keys, else
  // every row of the jobKey (whole-job ops keep their existing behavior).
  const jobRowIdsForUnit = (k) => (typeof k === "string" && k.startsWith("row:")) ? [Number(k.slice(4))] : jobRowIds(k);
  // The portion rows of a split job (same split_group), ordered stably by id.
  const splitPartsOf = (j) => j?.split_group ? jobs.filter(x => x.split_group === j.split_group).sort((a, b) => a.id - b.id) : [];
  // "Part i/N" label for a split portion row (empty for ordinary jobs).
  const splitLabel = (j) => {
    if (!j?.split_group) return "";
    const parts = splitPartsOf(j); const i = parts.findIndex(x => x.id === j.id);
    return parts.length > 1 ? `Part ${i + 1}/${parts.length}` : "Split";
  };
  async function logTripEvent(tripId, event_type, opts = {}) {
    if (tripEventsMissing) return;
    await supabase.from("trip_events").insert([{ trip_id: tripId, event_type, job_id: opts.job_id ?? null, storage_id: opts.storage_id ?? null, notes: opts.notes || null, created_by: opts.created_by || "dispatcher" }]);
    loadTripEvents();
  }
  // ── Driver handoff ──
  // A driver hands the WHOLE job to another driver: the new driver becomes the
  // primary (money follows him — cash-in-circulation defaults and new-extra
  // commission prefills read driver_ids[0]); other assigned drivers stay.
  async function handoffJob(k, toDriverId, reason, note) {
    const ids0 = jobRowIdsForUnit(k);
    const rows = jobs.filter(j => ids0.includes(j.id));
    if (!rows.length || !toDriverId) return;
    const toId = Number(toDriverId);
    const cur = Array.isArray(rows[0].driver_ids) ? rows[0].driver_ids.map(Number) : [];
    const fromId = cur[0] ?? null;
    if (fromId === toId) { window.alert("El job ya está a cargo de ese driver."); return; }
    const driver_ids = [toId, ...cur.filter(id => id !== toId && id !== fromId)];
    const names = driver_ids.map(id => driverById[id]?.name).filter(Boolean);
    setTripBusy(true);
    await supabase.from("storage_jobs").update({
      driver_ids, driver: names.join(", ") || null,
      updated_by: userEmail, updated_at: new Date().toISOString(),
    }).in("id", rows.map(j => j.id));
    const fromNm = (fromId != null && driverById[fromId]?.name) || rows[0].driver || "—";
    const toNm = driverById[toId]?.name || "—";
    const notes = `${rows[0].job_number || ""} · ${fromNm} → ${toNm} · ${handoffReasonLabel(reason)}${note ? ` · ${note}` : ""}`.trim();
    if (rows[0].trip_id) await logTripEvent(rows[0].trip_id, "driver_handoff", { job_id: Math.min(...rows.map(j => j.id)), notes, created_by: userEmail });
    else if (!jobEventsMissing) { await supabase.from("job_events").insert([{ job_id: Math.min(...rows.map(j => j.id)), event_date: today(), event_type: "driver_handoff", notes, created_by: userEmail }]); loadJobEvents(); }
    await loadJobs();
    setTripBusy(false);
    showToast(`Handoff registrado: ${fromNm} → ${toNm}`);
  }
  // Quick-set the measured cubic feet of a job (from the trip stop card):
  // occupancy math switches from the broker estimate to this value.
  async function quickSetRealCf(j) {
    // A split portion carries its own CF, so only its row is updated; an ordinary
    // job updates all its unit rows.
    const ids = jobRowIdsForUnit(tripUnitKey(j));
    const cur = hasRealCf(j) ? String(Math.round(Number(j.real_cf))) : "";
    const v = window.prompt(`CF real medido para ${j.job_number || j.customer || "el job"} (estimado: ${Math.round(parseCf(j.volume))} CF).\nVacío = volver al estimado.`, cur);
    if (v === null) return;
    const val = v.trim() === "" ? null : Number(v.trim());
    if (val !== null && (!isFinite(val) || val < 0)) { window.alert("Número inválido."); return; }
    await supabase.from("storage_jobs").update({ real_cf: val, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    await loadJobs();
    showToast(val === null ? "Real CF borrado — vuelve al estimado" : `Real CF: ${Math.round(val).toLocaleString()} CF`);
  }
  // Split one storage_jobs row into two portions so the job can ride two trucks.
  // The portion keeps the SAME job_number (so it stays ONE job in billing/analytics/
  // client view — see dedupeJobs), but gets its own CF, its own trip_id and status.
  // Money fields are zeroed on the portion so totals never double-count.
  async function splitJob(sourceRow, portionCf, dest) {
    if (!sourceRow) return;
    const total = effCf(sourceRow);
    const p = Number(portionCf);
    if (!isFinite(p) || p <= 0 || p >= total) {
      window.alert(trAI(`Enter a portion between 1 and ${Math.round(total) - 1} CF.`, `Ingresá una porción entre 1 y ${Math.round(total) - 1} CF.`));
      return;
    }
    setTripBusy(true);
    const sg = sourceRow.split_group || (jobKey(sourceRow) + ":" + Date.now());
    const now = new Date().toISOString();
    const useReal = !realCfMissing; // real_cf column present → store the CF numerically
    // 1) Keep the remainder on the source row (and mark it as a split if new).
    const srcPatch = { split_group: sg, updated_by: userEmail, updated_at: now };
    if (useReal) srcPatch.real_cf = total - p; else srcPatch.volume = String(Math.round(total - p));
    const { error: upErr } = await supabase.from("storage_jobs").update(srcPatch).eq("id", sourceRow.id);
    if (upErr) { setTripBusy(false); window.alert(upErr.message); return; }
    // 2) Build the portion from the columns that ACTUALLY exist on the source row.
    //    `select("*")` only returns real columns, so spreading `rest` never invents
    //    one (schemas vary — broker-share / billing columns are optional).
    const { id, created_at, updated_at, storage, ...rest } = sourceRow;
    const portion = { ...rest, split_group: sg, trip_id: null, trip_stop_order: null, date_out: null, status: "scheduled", created_by: userEmail };
    if (useReal) portion.real_cf = p; else portion.volume = String(Math.round(p));
    // Zero money / identity-duplicating fields — only those present on this schema.
    const zeroable = { bol_balance: 0, bol_collected: null, bol_collected_date: null, pickup_balance: 0, delivery_balance: 0, client_monthly_rate: null, billing_active: false, broker_job_share_amount: null, broker_job_share_pct: null, estimate: null, deposit: null, price_per_cf: null };
    for (const k in zeroable) if (k in portion) portion[k] = zeroable[k];
    // 3) Optionally place the portion straight onto an existing trip, or spin up a
    //    brand-new loading trip on a chosen (free) truck.
    let destTripId = null, destTrip = null;
    if (typeof dest === "string" && dest.startsWith("trip:")) {
      destTripId = Number(dest.slice(5));
      destTrip = trips.find(t => t.id === destTripId) || null;
    } else if (typeof dest === "string" && dest.startsWith("truck:")) {
      const truckId = Number(dest.slice(6));
      const tn = nextTripNumber();
      const { data: newTrip, error: tErr } = await supabase.from("trips")
        .insert([{ trip_number: tn, truck_id: truckId, departure_date: today(), status: "loading" }])
        .select("id").single();
      if (tErr) { setTripBusy(false); window.alert(tErr.message); return; }
      destTripId = newTrip?.id; destTrip = { id: destTripId, status: "loading", trip_number: tn };
    }
    if (destTripId) {
      portion.trip_id = destTripId;
      portion.trip_stop_order = (jobsByTrip[destTripId] || []).length + 1;
      // In-transit trip → the load is physically on the truck; loading trip → just
      // assigned (keep it scheduled, same as saveTrip).
      portion.status = (destTrip && destTrip.status !== "loading") ? "out_for_delivery" : "scheduled";
    }
    const { data: insData, error } = await supabase.from("storage_jobs").insert([portion]).select("id").single();
    if (!error && destTripId) await logTripEvent(destTripId, "job_added", { job_id: insData?.id, notes: (sourceRow.job_number || "") + " (split)" });
    setTripBusy(false);
    if (error) { window.alert(error.message); return; }
    setSplitJobRow(null); setSplitCf(""); setSplitDest("");
    const destName = destTrip ? (destTrip.trip_number || trips.find(t => t.id === destTripId)?.trip_number) : null;
    showToast(destName
      ? trAI(`Split: ${Math.round(p)} CF → ${destName}`, `Dividido: ${Math.round(p)} CF → ${destName}`)
      : trAI(`Job split: ${Math.round(total - p)} CF + ${Math.round(p)} CF`, `Job dividido: ${Math.round(total - p)} CF + ${Math.round(p)} CF`));
    loadJobs(); loadTrips();
  }
  // Undo a split: fold all portion CF back onto the original row and delete the
  // rest. The original (lowest id) keeps the money; portions never had any.
  async function mergeSplit(anyPortion) {
    const parts = splitPartsOf(anyPortion);
    if (parts.length < 2) return;
    const totalCf = Math.round(parts.reduce((s, p) => s + effCf(p), 0));
    const [primary, ...others] = parts;
    const onActive = parts.filter(p => p.trip_id && TRIP_ACTIVE(tripById[p.trip_id]?.status));
    const distinctTrips = new Set(onActive.map(p => p.trip_id));
    if (distinctTrips.size > 1 && !window.confirm(trAI(
      "These portions are on different active trips. Merge them back into one job anyway?",
      "Estas porciones están en trips activos distintos. ¿Volver a unirlas en un solo job igual?"))) return;
    setTripBusy(true);
    const { error } = await supabase.from("storage_jobs")
      .update({ split_group: null, real_cf: totalCf, updated_by: userEmail, updated_at: new Date().toISOString() })
      .eq("id", primary.id);
    if (!error && others.length) await supabase.from("storage_jobs").delete().in("id", others.map(p => p.id));
    setTripBusy(false);
    if (error) { window.alert(error.message); return; }
    showToast(trAI(`Portions merged: ${totalCf} CF`, `Porciones unidas: ${totalCf} CF`));
    loadJobs();
  }
  // Hand the whole trip (truck swap case) to another driver.
  async function handoffTrip(trip, toDriverId, reason, note) {
    const toId = Number(toDriverId);
    if (!toId || toId === Number(trip.driver_id)) { window.alert("Elegí un driver distinto al actual."); return; }
    setTripBusy(true);
    await supabase.from("trips").update({ driver_id: toId }).eq("id", trip.id);
    const fromNm = driverById[trip.driver_id]?.name || "—";
    const toNm = driverById[toId]?.name || "—";
    await logTripEvent(trip.id, "driver_handoff", { notes: `Trip completo · ${fromNm} → ${toNm} · ${handoffReasonLabel(reason)}${note ? ` · ${note}` : ""}`, created_by: userEmail });
    await loadTrips();
    setTripBusy(false);
    showToast(`Trip pasado a ${toNm}`);
  }
  // Add an existing (non-trip) job to a trip in transit, log it, queue a driver WA update.
  // purpose: 'relocation' rides the truck as an internal move (picked_up, no collection);
  // anything else is the normal delivery flow (out_for_delivery).
  async function tripAddExistingJob(trip, k, purpose) {
    const ids = jobRowIdsForUnit(k);
    const rows = jobs.filter(j => ids.includes(j.id));
    if (!rows.length) return;
    const reloc = purpose === "relocation" && !tripPurposeColMissing;
    setTripBusy(true);
    const order = (jobsByTrip[trip.id] || []).length + 1;
    const status = rows[0].date_out ? rows[0].status : (reloc ? "picked_up" : "out_for_delivery");
    await supabase.from("storage_jobs").update({ trip_id: trip.id, trip_stop_order: order, status, ...(tripPurposeColMissing ? {} : { trip_purpose: reloc ? "relocation" : "delivery" }), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    await logTripEvent(trip.id, "job_added", { job_id: Math.min(...ids), notes: (rows[0].job_number || "") + (reloc ? " · relocation" : "") });
    const newTotal = tripCalc(trip).loadedCf + effCf(rows[0]);
    await loadJobs();
    setTripBusy(false); setTripAction(null); setTripAddJobSearch("");
    setTripWaLink({ href: tripUpdateWaLink(trip, { ...rows[0], trip_purpose: reloc ? "relocation" : "delivery" }, newTotal), label: `Job ${rows[0].job_number || ""} added` });
    showToast(reloc ? `Job loaded for relocation — no collection` : `Job added to the trip`);
  }
  // Drop a job at a storage unit / warehouse: unlink from trip, set location, status in_storage.
  async function tripDropAtStorage(trip, k, target) {
    const ids = jobRowIdsForUnit(k);
    if (!ids.length || !target) return;
    setTripBusy(true);
    // Keep the job on the trip (trip_id / stop order stay) so it still shows there,
    // but mark it in_storage so it also appears in the storage/warehouse pages.
    const patch = { status: "in_storage", updated_by: userEmail, updated_at: new Date().toISOString() };
    if (target.kind === "warehouse") { patch.warehouse = target.name; patch.storage_id = null; }
    else { patch.storage_id = target.id; patch.warehouse = null; }
    await supabase.from("storage_jobs").update(patch).in("id", ids);
    const relocDrop = jobs.some(j => ids.includes(j.id) && isRelocation(j));
    await logTripEvent(trip.id, "storage_drop", { job_id: Math.min(...ids), storage_id: target.kind === "warehouse" ? null : target.id, notes: target.label + (relocDrop ? " · relocation" : "") });
    await loadJobs();
    setTripBusy(false); setStorageDropJob(null);
    const hasDelivery = jobs.some(j => ids.includes(j.id) && j.delivery_date);
    showToast(relocDrop ? `Job relocated to ${target.label}` : `Job dropped at ${target.label}${hasDelivery ? "" : " — pendiente agendar delivery"}`);
  }
  // Pick a job up from storage onto the trip. purpose 'relocation' = internal move
  // between locations: picked_up (never out_for_delivery), balances not collected.
  async function tripPickupFromStorage(trip, k, purpose) {
    const ids = jobRowIdsForUnit(k);
    if (!ids.length) return;
    const reloc = purpose === "relocation" && !tripPurposeColMissing;
    setTripBusy(true);
    const order = (jobsByTrip[trip.id] || []).length + 1;
    await supabase.from("storage_jobs").update({ trip_id: trip.id, trip_stop_order: order, status: reloc ? "picked_up" : "out_for_delivery", ...(tripPurposeColMissing ? {} : { trip_purpose: reloc ? "relocation" : "delivery" }), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    await logTripEvent(trip.id, "storage_pickup", { job_id: Math.min(...ids), notes: (jobs.find(j => ids.includes(j.id))?.job_number || "") + (reloc ? " · relocation" : "") });
    await loadJobs();
    setTripBusy(false); setTripAction(null);
    showToast(reloc ? `Job loaded for relocation — no collection` : `Job loaded onto the trip`);
  }
  // Load an already-assigned relocation stop onto the truck (status → picked_up),
  // keeping its stop order. Origin location fields stay on the row until the drop,
  // matching the delivery flow's convention.
  async function tripRelocLoad(trip, j) {
    const ids = jobRowIdsForUnit(tripUnitKey(j));
    if (!ids.length) return;
    setTripBusy(true);
    await supabase.from("storage_jobs").update({ status: "picked_up", updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    await logTripEvent(trip.id, "storage_pickup", { job_id: Math.min(...ids), storage_id: j.storage_id || null, notes: (j.job_number || "") + " · relocation" });
    await loadJobs();
    setTripBusy(false);
    showToast(`Job loaded for relocation — no collection`);
  }
  // Create an unplanned new job and immediately add it to the trip.
  async function saveUnplannedPickup(trip) {
    const f = unplannedForm;
    setTripBusy(true);
    const order = (jobsByTrip[trip.id] || []).length + 1;
    const payload = {
      job_number: f.job_number || null, customer: f.customer || null, volume: f.volume || null,
      pickup_address: f.pickup_address || null, delivery_address: f.delivery_address || null,
      fadd: f.fadd || null, broker_id: f.broker_id ? Number(f.broker_id) : null,
      sticker_color: f.sticker_color || null, lot_number: f.lot_number || null,
      job_type: "direct", status: "out_for_delivery", trip_id: trip.id, trip_stop_order: order,
      created_by: userEmail,
    };
    const { data, error } = await supabase.from("storage_jobs").insert([payload]).select("id").single();
    if (error) { setTripBusy(false); window.alert(error.message); return; }
    await logTripEvent(trip.id, "unplanned_pickup", { job_id: data?.id, notes: f.job_number || f.customer || "" });
    const newTotal = tripCalc(trip).loadedCf + effCf(f);
    await loadJobs();
    setTripBusy(false); setTripAction(null); setUnplannedForm(EMPTY_UNPLANNED);
    setTripWaLink({ href: tripUpdateWaLink(trip, payload, newTotal), label: `Unplanned pickup: ${f.job_number || f.customer || ""}` });
    showToast("Unplanned pickup added");
  }
  // Complete a trip: drop the still-on-truck jobs at a storage, release the ones
  // already dropped mid-trip (they keep their location), then mark completed.
  async function completeTrip(trip, onTruckKeys, droppedKeys, dropTarget) {
    const equipAboard = equipmentItems.filter(i => i.trip_id === trip.id);
    if (equipAboard.length && !window.confirm(trAI(
      `${equipAboard.length} equipment item(s) still on this trip — they will stay marked as in transit. Complete anyway?`,
      `${equipAboard.length} item(s) de equipo siguen en este trip — van a quedar marcados en tránsito. ¿Completar igual?`))) return;
    setTripBusy(true);
    const purposeClear = tripPurposeColMissing ? {} : { trip_purpose: null };
    if (onTruckKeys.length && dropTarget) {
      const t = dropTarget.kind === "warehouse" ? { warehouse: dropTarget.name, storage_id: null } : { storage_id: dropTarget.id, warehouse: null };
      for (const k of onTruckKeys) {
        const ids = jobRowIdsForUnit(k);
        await supabase.from("storage_jobs").update({ ...t, trip_id: null, trip_stop_order: null, ...purposeClear, status: "in_storage", updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
        await logTripEvent(trip.id, "storage_drop", { job_id: Math.min(...ids), storage_id: dropTarget.kind === "warehouse" ? null : dropTarget.id, notes: dropTarget.label });
      }
    }
    for (const k of (droppedKeys || [])) {
      const ids = jobRowIdsForUnit(k);
      await supabase.from("storage_jobs").update({ trip_id: null, trip_stop_order: null, ...purposeClear, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    }
    await supabase.from("trips").update({ status: "completed" }).eq("id", trip.id);
    setTripBusy(false); setTripCompleteModal(null); setCompleteDropTarget("");
    loadTrips(); loadJobs();
    showToast(`Trip ${trip.trip_number || trip.id} completed`);
  }

  // ── Equipment / materials (internal cargo — Equipment tab) ──
  async function saveEquipmentItem() {
    setEquipmentSaving(true);
    const f = equipmentForm;
    const loc = f.location || "";
    const payload = {
      name: f.name.trim() || null,
      category: f.category || "other",
      quantity: f.quantity === "" ? 1 : Number(f.quantity),
      storage_id: loc.startsWith("u:") ? Number(loc.slice(2)) : null,
      warehouse: loc.startsWith("w:") ? loc.slice(2) : null,
      notes: f.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };
    let error;
    if (editingEquipmentId) ({ error } = await supabase.from("equipment_items").update(payload).eq("id", editingEquipmentId));
    else ({ error } = await supabase.from("equipment_items").insert([{ ...payload, created_by: userEmail }]));
    setEquipmentSaving(false);
    if (error) { window.alert(error.message); return; }
    setShowEquipmentModal(false); loadEquipment();
  }
  async function deleteEquipmentItem(item) {
    if (!window.confirm(trAI(`Delete "${item.name || "this item"}"?`, `¿Eliminar "${item.name || "este item"}"?`))) return;
    await supabase.from("equipment_items").delete().eq("id", item.id);
    loadEquipment();
  }
  // Load an equipment item onto an active trip (rides as internal cargo, no money).
  async function equipmentLoadOnTrip(item, tripId) {
    const { error } = await supabase.from("equipment_items").update({ trip_id: tripId, status: "in_transit", updated_at: new Date().toISOString() }).eq("id", item.id);
    if (error) { window.alert(error.message); return; }
    await logTripEvent(tripId, "equipment_loaded", { notes: `${item.name || "equipment"} ×${numv(item.quantity) || 1}`, created_by: userEmail });
    setEquipLoadItem(null); loadEquipment();
    showToast(trAI("Equipment loaded onto the trip", "Equipo cargado al trip"));
  }
  // Unload an equipment item at a storage unit / warehouse and free it from the trip.
  async function equipmentUnload(item, target) {
    if (!target) return;
    const patch = { trip_id: null, status: "available", updated_at: new Date().toISOString() };
    if (target.kind === "warehouse") { patch.warehouse = target.name; patch.storage_id = null; }
    else { patch.storage_id = target.id; patch.warehouse = null; }
    const { error } = await supabase.from("equipment_items").update(patch).eq("id", item.id);
    if (error) { window.alert(error.message); return; }
    if (item.trip_id) await logTripEvent(item.trip_id, "equipment_unloaded", { storage_id: target.kind === "warehouse" ? null : target.id, notes: `${item.name || "equipment"} → ${target.label}`, created_by: userEmail });
    setEquipUnloadItem(null); loadEquipment();
    showToast(trAI(`Equipment unloaded at ${target.label}`, `Equipo descargado en ${target.label}`));
  }

  // ── Manual job timeline events ──
  // Save a manual event on a job; optionally prompt to align the job status.
  async function saveJobEvent(jobKeyStr, repId) {
    const f = jobEventForm; if (!f) return;
    const meta = jobEventMeta(f.event_type);
    const payload = {
      job_id: repId, event_date: f.event_date || today(), event_type: f.event_type,
      notes: f.notes || null,
      storage_id: f.storage_id && !String(f.storage_id).startsWith("wh:") ? Number(f.storage_id) : null,
      storage_label: f.storage_label || null,
      trip_ref: f.trip_ref || null, created_by: userEmail,
    };
    const { error } = await supabase.from("job_events").insert([payload]);
    if (error) { window.alert(error.message); return; }
    setJobEventForm(null);
    await loadJobEvents();
    // Optional status alignment (never forced).
    if (meta.status) {
      const ids = jobs.filter(j => jobKey(j) === jobKeyStr).map(j => j.id);
      if (ids.length && window.confirm(`Update the job status to "${statusMeta(meta.status).l}"?`)) {
        const patch = { status: meta.status, updated_by: userEmail, updated_at: new Date().toISOString() };
        if (meta.status === "delivered") patch.date_out = f.event_date || today();
        await supabase.from("storage_jobs").update(patch).in("id", ids);
        loadJobs();
      }
    }
    showToast("Event added");
  }
  async function deleteJobEvent(ev) {
    if (!window.confirm("Delete this timeline event?")) return;
    await supabase.from("job_events").delete().eq("id", ev.id);
    loadJobEvents();
  }

  // ── Extras & commissions handlers ──
  // Build a job_extras payload. For Extra CF the amount = total charged (CF + fuel)
  // and commissions are computed on the chosen base (with/without fuel surcharge).
  function extraPayload(o) {
    const isCf = o.extra_type === "extra_cf";
    const cf = isCf ? extraCfCalc(o) : null;
    // The "amount" stored = total charged to the client (= CF total w/ fuel for extra_cf).
    const a = isCf ? cf.total : numv(o.amount);
    // Broker share: % the broker keeps from this extra.
    const bsPct = (o.broker_share_pct === "" || o.broker_share_pct == null) ? 0 : numv(o.broker_share_pct);
    const brokerShareAmount = a * bsPct / 100;
    const netAmount = a - brokerShareAmount;
    // Commission base: extra_cf keeps the fuel choice (with/without fuel); everything
    // else uses gross (full amount) or net (after broker share).
    let commissionBaseVal, commBase;
    if (isCf) { commissionBaseVal = cf.commissionBase; commBase = cf.base; }
    else { commissionBaseVal = (o.commission_base === "net") ? "net" : "gross"; commBase = (commissionBaseVal === "net") ? netAmount : a; }
    const dPct = (o.driver_commission_pct === "" || o.driver_commission_pct == null) ? null : numv(o.driver_commission_pct);
    const rPct = (o.rep_commission_pct === "" || o.rep_commission_pct == null) ? null : numv(o.rep_commission_pct);
    const dc = commBase * numv(dPct) / 100, rc = commBase * numv(rPct) / 100;
    const payload = {
      extra_type: o.extra_type, description: o.description || null,
      amount: isCf ? a : ((o.amount === "" || o.amount == null) ? null : a),
      generated_by: o.generated_by || "driver_only",
      driver_id: o.driver_id || null,
      rep_id: (o.generated_by === "driver_only") ? null : (o.rep_id || null),
      driver_commission_pct: dPct, rep_commission_pct: rPct,
      driver_commission_amount: dc, rep_commission_amount: rc,
      company_amount: netAmount - dc - rc, active: o.active !== false,
      notes: o.notes || null,
    };
    if (!extrasColsMissing) {
      payload.extra_cf_count = isCf ? ((o.extra_cf_count === "" || o.extra_cf_count == null) ? null : cf.cfCount) : null;
      payload.extra_cf_rate = isCf ? ((o.extra_cf_rate === "" || o.extra_cf_rate == null) ? null : cf.cfRate) : null;
      payload.extra_cf_subtotal = isCf ? cf.cfSub : null;
      payload.fuel_surcharge_pct = isCf ? cf.fuelPct : null;
      payload.fuel_surcharge_amount = isCf ? cf.fuelAmt : null;
      payload.extra_total_with_fuel = isCf ? cf.total : null;
      payload.commission_base = commissionBaseVal;
      payload.commission_base_amount = commBase;
    }
    if (!brokerShareMissing) {
      payload.broker_share_pct = bsPct;
      payload.broker_share_amount = brokerShareAmount;
      payload.net_amount = netAmount;
    }
    return payload;
  }
  // The amount the commission % applies to (stored base if present, else amount).
  const extraCommBase = (e) => e.commission_base_amount != null ? numv(e.commission_base_amount) : (e.extra_type === "extra_cf" ? numv(e.commission_base_amount) : numv(e.amount));
  // Broker share kept from an extra (live fallback if not yet stored).
  const extraBrokerShare = (e) => e.broker_share_amount != null ? numv(e.broker_share_amount) : (numv(e.amount) * numv(e.broker_share_pct) / 100);
  const extraNet = (e) => e.net_amount != null ? numv(e.net_amount) : (numv(e.amount) - extraBrokerShare(e));
  // A payment-split extra whose commission was never assigned (no driver/rep yet).
  const extraPending = (e) => e.source === "payment_split" && !e.driver_id && !e.rep_id;
  // Create an extra of a given type for a (job, driver). Pcts auto-fill from rules.
  async function activateExtra(jobId, driverId, type) {
    const gen = "driver_only";
    const d = commissionDefaults(type, gen);
    await supabase.from("job_extras").insert([{ job_id: jobId, ...extraPayload({ extra_type:type, amount:"", generated_by:gen, driver_id:driverId, driver_commission_pct:d.driver, rep_commission_pct:d.rep, active:true }) }]);
    loadExtras();
  }
  // Patch an existing extra; changing generated_by re-applies the default %s.
  async function patchExtra(extra, fields) {
    const merged = { ...extra, ...fields };
    if ("generated_by" in fields) {
      const d = commissionDefaults(merged.extra_type, merged.generated_by);
      merged.driver_commission_pct = d.driver; merged.rep_commission_pct = d.rep;
      if (merged.generated_by === "driver_only") merged.rep_id = null;
    }
    await supabase.from("job_extras").update(extraPayload(merged)).eq("id", extra.id);
    loadExtras();
  }
  async function toggleExtraActive(extra, active) {
    await supabase.from("job_extras").update({ active }).eq("id", extra.id);
    loadExtras();
  }
  async function deleteExtra(extra) {
    // Payments already allocated to this extra → keep the history: confirm and
    // soft-deactivate instead of hard-deleting (the charge stops counting).
    const linked = payments.filter(p => (p.job_extra_id != null && Number(p.job_extra_id) === Number(extra.id)) || (p.job_extra_id == null && p.concept === "extra" && extra.payment_id != null && Number(extra.payment_id) === Number(p.id)));
    if (linked.length) {
      const sum = linked.reduce((s, p) => s + paymentNet(p), 0);
      if (!window.confirm(`Este extra tiene ${linked.length} pago(s) asignados por $${Math.round(sum).toLocaleString()}. Se desactivará (deja de contar como cargo) conservando el historial de pagos. ¿Continuar?`)) return;
      await supabase.from("job_extras").update({ active: false }).eq("id", extra.id);
      loadExtras();
      return;
    }
    await supabase.from("job_extras").delete().eq("id", extra.id);
    loadExtras();
  }
  async function saveQuickExtra() {
    const q = quickExtra; if (!q || (!q.jobId && !q.id)) return;
    if (q.id) await supabase.from("job_extras").update(extraPayload(q)).eq("id", q.id);
    else await supabase.from("job_extras").insert([{ job_id: q.jobId, ...extraPayload(q) }]);
    setQuickExtra(null); loadExtras();
  }
  // "+ Extra" from the Payments page: same modal, but the job is picked inside
  // (the drawer flow pre-selects it). Creating the charge is a first-class
  // action — payments get allocated against it afterwards.
  function openAddExtraFromPayments() {
    setQuickExtra({ jobId:"", _pickJob:true, extra_type:"extra_cf", description:"", amount:"", generated_by:"driver_only", driver_id:"", rep_id:"", driver_commission_pct:10, rep_commission_pct:0, notes:"", extra_cf_count:"", extra_cf_rate:"", fuel_surcharge_pct:"", commission_base:"with_fuel", broker_share_pct:"", broker_share_enabled:false });
  }
  // Open the extra modal pre-filled from an existing extra (used to edit Extra CF details).
  function openEditExtra(e) {
    const isCf = (e.extra_type || "extra_cf") === "extra_cf";
    setQuickExtra({
      id: e.id, jobId: e.job_id, extra_type: e.extra_type || "extra_cf", description: e.description || "",
      amount: e.amount ?? "", generated_by: e.generated_by || "driver_only",
      driver_id: e.driver_id || "", rep_id: e.rep_id || "",
      driver_commission_pct: e.driver_commission_pct ?? "", rep_commission_pct: e.rep_commission_pct ?? "",
      notes: e.notes || "",
      extra_cf_count: e.extra_cf_count ?? "", extra_cf_rate: e.extra_cf_rate ?? "",
      fuel_surcharge_pct: e.fuel_surcharge_pct ?? "", commission_base: e.commission_base || (isCf ? "with_fuel" : "gross"),
      broker_share_pct: e.broker_share_pct ?? "", broker_share_enabled: numv(e.broker_share_pct) > 0,
    });
  }
  // ── Employees (reps) CRUD ──
  async function saveEmployee() {
    if (!empForm.name.trim()) return;
    setEmpSaving(true);
    await supabase.from("employees").insert([{ name:empForm.name.trim(), role:empForm.role||null, phone:empForm.phone||null, email:empForm.email||null, active:true }]);
    setEmpSaving(false); setEmpForm(EMPTY_EMPLOYEE); loadEmployees();
  }
  async function deleteEmployee(em) {
    if (!window.confirm(`Delete "${em.name}"?`)) return;
    await supabase.from("employees").delete().eq("id", em.id); loadEmployees();
  }
  // Per-driver export: build a plain-text payment summary, copy to clipboard.
  function driverExtrasReport(driverName, monthLabel, jobsData) {
    const lines = [`EXTRAS & COMISIONES — ${driverName}`, monthLabel, ""];
    let totAmt = 0, totComm = 0;
    for (const jd of jobsData) {
      lines.push(`Job ${jd.job_number || "—"} · ${jd.customer || ""}`.trim());
      for (const e of jd.extras) {
        totAmt += numv(e.amount); totComm += numv(e.driver_commission_amount);
        lines.push(`   ${extraTypeLabel(e.extra_type)}${e.extra_type === "other" && e.description ? ` (${e.description})` : ""}: $${numv(e.amount).toLocaleString()}  →  commission driver $${numv(e.driver_commission_amount).toLocaleString()} (${numv(e.driver_commission_pct)}%)`);
      }
    }
    lines.push("", `TOTAL EXTRAS: $${totAmt.toLocaleString()}`, `TOTAL COMMISSION DRIVER: $${totComm.toLocaleString()}`);
    return lines.join("\n");
  }
  async function copyDriverExtras(driverName, monthLabel, jobsData) {
    const txt = driverExtrasReport(driverName, monthLabel, jobsData);
    try { await navigator.clipboard.writeText(txt); window.alert("Summary copied to clipboard."); }
    catch { window.prompt("Copy the summary:", txt); }
  }
  function printDriverExtras(driverName, monthLabel, jobsData) {
    let totAmt = 0, totComm = 0;
    const rows = jobsData.flatMap(jd => jd.extras.map(e => {
      totAmt += numv(e.amount); totComm += numv(e.driver_commission_amount);
      return `<tr><td>${jd.job_number || "—"}</td><td>${jd.customer || ""}</td><td>${extraTypeLabel(e.extra_type)}${e.extra_type === "other" && e.description ? ` (${e.description})` : ""}</td><td style="text-align:right">$${numv(e.amount).toLocaleString()}</td><td style="text-align:right">${numv(e.driver_commission_pct)}%</td><td style="text-align:right">$${numv(e.driver_commission_amount).toLocaleString()}</td></tr>`;
    })).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Extras ${driverName}</title>
      <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px;color:#111}h1{font-size:20px;margin:0}.sub{color:#666;margin:4px 0 18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #ddd;padding:7px 9px;text-align:left}th{background:#f5f5f5}tfoot td{font-weight:700;background:#FEF9C3}</style></head>
      <body><h1>Extras & Comisiones — ${driverName}</h1><div class="sub">${monthLabel}</div>
      <table><thead><tr><th>Job #</th><th>Client</th><th>Extra</th><th style="text-align:right">Amount</th><th style="text-align:right">%</th><th style="text-align:right">Commission</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#999">No extras</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">TOTAL</td><td style="text-align:right">$${totAmt.toLocaleString()}</td><td></td><td style="text-align:right">$${totComm.toLocaleString()}</td></tr></tfoot></table>
      <script>window.onload=function(){window.print();}</script></body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
  }
  // Per-rep export: rows carry the assigned driver + rep commission.
  function repExtrasReport(repName, monthLabel, jobsData) {
    const lines = [`COMISIONES REP — ${repName}`, monthLabel, ""];
    let totAmt = 0, totComm = 0;
    for (const jd of jobsData) {
      lines.push(`Job ${jd.job_number || "—"} · ${jd.customer || ""}${jd.driverName ? ` · 🧑‍✈️ ${jd.driverName}` : ""}`.trim());
      for (const e of jd.extras) {
        totAmt += numv(e.amount); totComm += numv(e.rep_commission_amount);
        lines.push(`   ${extraTypeLabel(e.extra_type)}${e.extra_type === "other" && e.description ? ` (${e.description})` : ""}: $${numv(e.amount).toLocaleString()}  →  commission rep $${numv(e.rep_commission_amount).toLocaleString()} (${numv(e.rep_commission_pct)}%)`);
      }
    }
    lines.push("", `TOTAL EXTRAS: $${totAmt.toLocaleString()}`, `TOTAL COMMISSION REP: $${totComm.toLocaleString()}`);
    return lines.join("\n");
  }
  async function copyRepExtras(repName, monthLabel, jobsData) {
    const txt = repExtrasReport(repName, monthLabel, jobsData);
    try { await navigator.clipboard.writeText(txt); window.alert("Summary copied to clipboard."); }
    catch { window.prompt("Copy the summary:", txt); }
  }
  function printRepExtras(repName, monthLabel, jobsData) {
    let totAmt = 0, totComm = 0;
    const rows = jobsData.flatMap(jd => jd.extras.map(e => {
      totAmt += numv(e.amount); totComm += numv(e.rep_commission_amount);
      return `<tr><td>${jd.job_number || "—"}</td><td>${jd.customer || ""}</td><td>${jd.driverName || ""}</td><td>${extraTypeLabel(e.extra_type)}${e.extra_type === "other" && e.description ? ` (${e.description})` : ""}</td><td style="text-align:right">$${numv(e.amount).toLocaleString()}</td><td style="text-align:right">${numv(e.rep_commission_pct)}%</td><td style="text-align:right">$${numv(e.rep_commission_amount).toLocaleString()}</td></tr>`;
    })).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Comisiones ${repName}</title>
      <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px;color:#111}h1{font-size:20px;margin:0}.sub{color:#666;margin:4px 0 18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #ddd;padding:7px 9px;text-align:left}th{background:#f5f5f5}tfoot td{font-weight:700;background:#FEF9C3}</style></head>
      <body><h1>Comisiones Rep — ${repName}</h1><div class="sub">${monthLabel}</div>
      <table><thead><tr><th>Job #</th><th>Client</th><th>Driver</th><th>Extra</th><th style="text-align:right">Amount</th><th style="text-align:right">%</th><th style="text-align:right">Commission</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#999">No extras</td></tr>'}</tbody>
      <tfoot><tr><td colspan="4">TOTAL</td><td style="text-align:right">$${totAmt.toLocaleString()}</td><td></td><td style="text-align:right">$${totComm.toLocaleString()}</td></tr></tfoot></table>
      <script>window.onload=function(){window.print();}</script></body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
  }

  // ── Payments handlers ──
  // ── Charge-allocation helpers (payments ↔ job charges) ──
  // Build editable allocation lines for a job: one row per outstanding charge
  // (job balance + each active extra), auto-filled greedily from the amount.
  function seedAllocLines(jobId, amount) {
    const k = jobKeyByRowId[Number(jobId)];
    if (!k) return null;
    const charges = chargeStateByJobKey(k);
    const { lines } = proposeAllocation(numv(amount), charges);
    return lines.map(l => ({
      kind: l.kind, job_extra_id: l.job_extra_id, remaining: l.remaining, amount: l.amount, touched: false, notes: "",
      label: l.kind === "job" ? "Job balance" : (() => {
        const e = charges.extraCharges.find(c => Number(c.extra.id) === Number(l.job_extra_id))?.extra;
        return e ? extraTypeLabel(e.extra_type) + (e.description ? ` · ${e.description}` : "") : "Extra";
      })(),
      extra_type: l.kind === "extra" ? (charges.extraCharges.find(c => Number(c.extra.id) === Number(l.job_extra_id))?.extra.extra_type || null) : null,
    }));
  }
  // A job "wants" allocation when it has extras with something still unpaid.
  function jobWantsAllocation(jobId) {
    const k = jobKeyByRowId[Number(jobId)];
    if (!k) return false;
    return chargeStateByJobKey(k).extraCharges.some(c => c.remaining > 0);
  }

  function openAddPayment(prefill = {}) {
    setEditingPayId(null); setReallocPay(null);
    const base = { ...EMPTY_PAYMENT, split_enabled: false, split_lines: [{ concept: "job", amount: "", notes: "" }], alloc_lines: null, payment_date: today(), received: true, received_date: today(), ...prefill };
    // Auto-arm the allocation panel when the job has pending extras.
    if (!splitMissing && !allocMissing && base.job_id && jobWantsAllocation(base.job_id)) {
      base.split_enabled = true;
      base.alloc_lines = seedAllocLines(base.job_id, base.amount);
    }
    setPayForm(base);
    setPayJobSearch(""); setShowPayModal(true);
  }
  function openEditPayment(p) {
    setEditingPayId(p.id);
    setPayForm({
      job_id: p.job_id || "", payment_date: p.payment_date || "", amount: p.amount ?? "", concept: p.concept || "job",
      method: p.method || "cash", method_id: p.method_id || "", check_type: p.check_type || "",
      discount: p.discount ?? "", discount_reason: p.discount_reason || "",
      received: !!p.received, received_date: p.received_date || "", received_by: p.received_by || "",
      cash_with_whom: p.cash_with_whom || "", banked: !!p.banked, banked_date: p.banked_date || "",
      bank_account: p.bank_account || "", payment_stage: p.payment_stage || "", notes: p.notes || "",
      check_serial: p.check_serial || "", check_transaction_number: p.check_transaction_number || "", check_remitter: p.check_remitter || "",
      check_purchased_by: p.check_purchased_by || "", check_bank: p.check_bank || "", check_from: p.check_from || "",
      check_routing: p.check_routing || "", check_account_last4: p.check_account_last4 || "", check_date: p.check_date || "",
      check_memo: p.check_memo || "", check_photo_url: p.check_photo_url || "",
      mo_type: p.mo_type || "usps", mo_serial: p.mo_serial || "", mo_date: p.mo_date || "", mo_post_office: p.mo_post_office || "",
      mo_from_name: p.mo_from_name || "", mo_from_address: p.mo_from_address || "", mo_payment_for: p.mo_payment_for || "",
      mo_issuer_location: p.mo_issuer_location || "", mo_photo_url: p.mo_photo_url || "",
      cc_fee_enabled: p.cc_fee_enabled !== false, cc_fee_pct: p.cc_fee_pct ?? "3", cc_fee_amount: p.cc_fee_amount ?? "", cc_fee_payment_id: p.cc_fee_payment_id || null,
    });
    setReallocPay(null); setPayJobSearch(""); setShowPayModal(true);
  }
  // Re-assign an "A cuenta" payment: open it with the allocation panel forced
  // on and the (fixed) amount pre-spread over the outstanding charges.
  function openReallocatePayment(p) {
    openEditPayment(p);
    setReallocPay(p);
    setPayForm(f => ({ ...f, split_enabled: true, alloc_lines: seedAllocLines(p.job_id, numv(p.amount)) }));
  }
  // Upload a check / money-order photo to the payment-docs bucket; stash url in the form field.
  async function uploadPaymentDoc(file, field) {
    if (!file) return;
    setPayDocUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      const path = `pay-${editingPayId || "new"}-${field}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("payment-docs").upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (error) { window.alert("Upload error: " + error.message); setPayDocUploading(false); return; }
      const { data } = supabase.storage.from("payment-docs").getPublicUrl(path);
      setPayForm(f => ({ ...f, [field]: data?.publicUrl || "" }));
    } catch (e) { window.alert("Error: " + e.message); }
    setPayDocUploading(false);
  }
  // The driver name assigned to a job (by job_id row), used to default who holds the cash.
  function jobDriverNameFor(jobId) {
    if (!jobId) return "";
    const k = jobKeyByRowId[Number(jobId)];
    const row = k ? jobs.find(j => jobKey(j) === k) : null;
    if (!row) return "";
    return (Array.isArray(row.driver_ids) && row.driver_ids.length ? driverById[row.driver_ids[0]]?.name : "") || row.driver || "";
  }
  function payPayload(f) {
    const digital = isDigitalMethod(f.method);
    const received = digital ? true : !!f.received;       // digital payments arrive already received
    const banked = digital ? true : !!f.banked;           // ...and auto-banked
    // Cash/check/money order not yet banked → goes into circulation under whoever holds it
    // (default to the job's assigned driver when not set).
    let cww = f.cash_with_whom;
    if (isPhysical(f.method) && !banked && !cww) cww = jobDriverNameFor(f.job_id);
    const payload = {
      job_id: f.job_id ? Number(f.job_id) : null,
      payment_date: f.payment_date || null,
      amount: f.amount === "" ? null : numv(f.amount),
      concept: f.concept || "job",
      method: f.method || null,
      method_id: f.method_id || null,
      check_type: (f.method === "check") ? (f.check_type || null) : null,
      discount: f.discount === "" ? 0 : numv(f.discount),
      discount_reason: f.discount_reason || null,
      received, received_date: received ? (f.received_date || today()) : null,
      received_by: f.received_by || null,
      cash_with_whom: (isPhysical(f.method) && !banked) ? (cww || null) : null,
      banked, banked_date: banked ? (f.banked_date || today()) : null,
      bank_account: banked ? (f.bank_account || null) : null,
      notes: f.notes || null,
    };
    if (!payStageMissing) payload.payment_stage = f.payment_stage || null;
    if (!payColsMissing) {
      const isCheck = f.method === "check", isMo = f.method === "money_order", isCC = f.method === "credit_card";
      payload.check_serial = isCheck ? (f.check_serial || null) : null;
      payload.check_transaction_number = isCheck ? (f.check_transaction_number || null) : null;
      payload.check_remitter = isCheck ? (f.check_remitter || null) : null;
      payload.check_purchased_by = isCheck ? (f.check_purchased_by || null) : null;
      payload.check_bank = isCheck ? (f.check_bank || null) : null;
      payload.check_from = isCheck ? (f.check_from || null) : null;
      payload.check_routing = isCheck ? (f.check_routing || null) : null;
      payload.check_account_last4 = isCheck ? (f.check_account_last4 || null) : null;
      payload.check_date = isCheck ? (f.check_date || null) : null;
      payload.check_memo = isCheck ? (f.check_memo || null) : null;
      payload.check_photo_url = isCheck ? (f.check_photo_url || null) : null;
      payload.mo_type = isMo ? (f.mo_type || null) : null;
      payload.mo_serial = isMo ? (f.mo_serial || null) : null;
      payload.mo_date = isMo ? (f.mo_date || null) : null;
      payload.mo_post_office = isMo ? (f.mo_post_office || null) : null;
      payload.mo_from_name = isMo ? (f.mo_from_name || null) : null;
      payload.mo_from_address = isMo ? (f.mo_from_address || null) : null;
      payload.mo_payment_for = isMo ? (f.mo_payment_for || null) : null;
      payload.mo_issuer_location = isMo ? (f.mo_issuer_location || null) : null;
      payload.mo_photo_url = isMo ? (f.mo_photo_url || null) : null;
      const feeEnabled = isCC && !!f.cc_fee_enabled;
      payload.cc_fee_enabled = feeEnabled;
      payload.cc_fee_pct = isCC ? (f.cc_fee_pct === "" ? null : numv(f.cc_fee_pct)) : null;
      payload.cc_fee_amount = feeEnabled ? (numv(f.amount) * numv(f.cc_fee_pct) / 100) : null;
    }
    return payload;
  }
  // Build the commission-assignment modal state for a payment-split extra (defaults from rules).
  function commAssignInit(extra, queue) {
    const gen = "driver_only";
    const d = commissionDefaults(extra.extra_type, gen);
    return { extra, queue: queue || [], generated_by: gen, driver_id: extra.driver_id || "", rep_id: extra.rep_id || "", driver_pct: String(d.driver), rep_pct: String(d.rep) };
  }
  function openCommAssign(extra) { setCommAssign(commAssignInit(extra, [])); }
  function advanceCommQueue() {
    setCommAssign(ca => (ca && ca.queue.length) ? commAssignInit(ca.queue[0], ca.queue.slice(1)) : null);
  }
  async function saveCommAssign() {
    const ca = commAssign; if (!ca) return;
    const base = numv(ca.extra.amount);
    const gen = ca.generated_by;
    const dPct = ca.driver_pct === "" ? null : numv(ca.driver_pct);
    const rPct = ca.rep_pct === "" ? null : numv(ca.rep_pct);
    const dc = base * numv(dPct) / 100, rc = base * numv(rPct) / 100;
    await supabase.from("job_extras").update({
      generated_by: gen, driver_id: ca.driver_id || null,
      rep_id: gen === "driver_only" ? null : (ca.rep_id || null),
      driver_commission_pct: dPct, rep_commission_pct: rPct,
      driver_commission_amount: dc, rep_commission_amount: rc,
      company_amount: base - dc - rc,
    }).eq("id", ca.extra.id);
    loadExtras();
    advanceCommQueue();
  }
  // Split payment: one entered total fanned out into several linked payment rows
  // (same job/date/method/check/MO), with extra lines auto-linked to job_extras.
  async function saveSplitPayment(f) {
    const lines = (f.split_lines || []).filter(l => l.amount !== "" && numv(l.amount) !== 0);
    const total = numv(f.amount);
    const splitTotal = lines.reduce((s, l) => s + numv(l.amount), 0);
    if (!lines.length) { window.alert("Add at least one line with an amount."); return; }
    if (Math.abs(splitTotal - total) > 0.01) { window.alert(`El total de las divisiones ($${splitTotal.toLocaleString()}) no coincide con el monto ingresado ($${total.toLocaleString()}).`); return; }
    const hasExtra = lines.some(l => splitConcept(l.concept).extra);
    if (hasExtra && !f.job_id) { window.alert("Select a job to record the extras and their commissions."); return; }
    setPaySaving(true);
    const group = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : ("split-" + Date.now());
    const base = payPayload(f);
    base.discount = 0; base.discount_reason = null;          // discounts not split across lines
    if (!payColsMissing) { base.cc_fee_enabled = false; base.cc_fee_amount = null; base.cc_fee_payment_id = null; }
    const createdExtras = [];
    let jobLineSum = 0, err = null;
    for (const l of lines) {
      const sc = splitConcept(l.concept);
      const linePayload = { ...base, amount: numv(l.amount), concept: sc.pay, notes: l.notes || base.notes };
      if (!splitMissing) { linePayload.split_group = group; linePayload.extra_type = sc.extra || null; }
      const { data: pd, error: insErr } = await supabase.from("payments").insert([linePayload]).select("id").single();
      if (insErr) { err = insErr; break; }
      if (sc.pay === "job") jobLineSum += numv(l.amount);
      if (sc.extra && f.job_id && !extrasMissing && !splitMissing) {
        // If the job already has an active extra of this type (added via "+ Add extra"),
        // the payment counts as collected against it — creating another row would
        // double the billed total. Only auto-create the extra when none exists yet.
        const k = jobKeyByRowId[Number(f.job_id)];
        const jobExs = k ? (extrasByJobKey[k] || []) : jobExtras.filter(e => e.job_id === Number(f.job_id));
        const alreadyBilled = jobExs.some(e => e.active !== false && e.extra_type === sc.extra);
        if (!alreadyBilled) {
          const exPayload = {
            job_id: Number(f.job_id), extra_type: sc.extra, description: l.notes || null,
            amount: numv(l.amount), generated_by: "driver_only",
            driver_id: null, rep_id: null, driver_commission_pct: null, rep_commission_pct: null,
            driver_commission_amount: 0, rep_commission_amount: 0, company_amount: numv(l.amount),
            active: true, source: "payment_split", payment_id: pd?.id || null,
          };
          const { data: ed } = await supabase.from("job_extras").insert([exPayload]).select("*").single();
          if (ed) createdExtras.push(ed);
        }
      }
    }
    // Two-way sync: job-concept lines mirror bol_collected on the storage_job rows.
    if (!err && jobLineSum > 0 && f.job_id) {
      const k = jobKeyByRowId[Number(f.job_id)];
      const ids = k ? jobs.filter(j => jobKey(j) === k).map(j => j.id) : [];
      if (ids.length) await supabase.from("storage_jobs").update({ bol_collected: jobLineSum, bol_payment_method: f.method || null, bol_collected_date: f.payment_date || today(), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    }
    setPaySaving(false);
    if (err) { window.alert(err.message); return; }
    setShowPayModal(false); loadPayments(); loadJobs(); loadExtras();
    // Prompt to assign commission for each auto-created extra.
    if (createdExtras.length) {
      const toAssign = [];
      for (const e of createdExtras) {
        if (window.confirm(`$${Math.round(numv(e.amount)).toLocaleString()} ${extraTypeLabel(e.extra_type)} recorded. Assign commission now?`)) toAssign.push(e);
      }
      if (toAssign.length) setCommAssign(commAssignInit(toAssign[0], toAssign.slice(1)));
    }
  }
  // Save a payment allocated against the job's charges. One payments row per
  // allocation line (grouped by split_group like the legacy split flow):
  //   job line   → concept "job" (bol_collected sync preserved)
  //   extra line → concept "extra" + job_extra_id (pays an EXISTING charge —
  //                no new job_extras row, no commission prompt)
  //   custom line→ legacy behavior (new extra on the fly / cc_fee / other)
  //   remainder  → concept "on_account" ("a cuenta", re-assignable later)
  async function saveAllocatedPayment(f) {
    const { rows, unassigned, error: allocErr } = serializeAllocLines(f.alloc_lines, numv(f.amount));
    if (allocErr) { window.alert(allocErr); return; }
    if (!rows.length && unassigned <= 0) { window.alert("Add at least one line with an amount."); return; }
    setPaySaving(true);
    const base = payPayload(f);
    base.discount = 0; base.discount_reason = null;
    if (!payColsMissing) { base.cc_fee_enabled = false; base.cc_fee_amount = null; base.cc_fee_payment_id = null; }
    const single = rows.length === 1 && unassigned <= 0;
    const group = single ? null : ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : ("split-" + Date.now()));
    const createdExtras = [];
    let jobLineSum = 0, err = null;
    const insertRow = async (payload) => {
      if (group && !splitMissing) payload.split_group = group;
      const { data, error: insErr } = await supabase.from("payments").insert([payload]).select("id").single();
      if (insErr) err = insErr;
      return data;
    };
    for (const l of rows) {
      if (err) break;
      if (l.kind === "job") {
        await insertRow({ ...base, amount: l.amount, concept: "job", notes: l.notes || base.notes });
        jobLineSum += l.amount;
      } else if (l.kind === "extra") {
        const payload = { ...base, amount: l.amount, concept: "extra", notes: l.notes || base.notes };
        if (!splitMissing) payload.extra_type = l.extra_type || null;
        if (!allocMissing) payload.job_extra_id = l.job_extra_id || null;
        await insertRow(payload);
      } else { // custom line — same semantics as the legacy split builder
        const sc = splitConcept(l.concept);
        const payload = { ...base, amount: l.amount, concept: sc.pay, notes: l.notes || base.notes };
        if (!splitMissing) payload.extra_type = sc.extra || null;
        const pd = await insertRow(payload);
        if (sc.pay === "job") jobLineSum += l.amount;
        if (sc.extra && f.job_id && !extrasMissing && !splitMissing && pd?.id) {
          const exPayload = {
            job_id: Number(f.job_id), extra_type: sc.extra, description: l.notes || null,
            amount: l.amount, generated_by: "driver_only",
            driver_id: null, rep_id: null, driver_commission_pct: null, rep_commission_pct: null,
            driver_commission_amount: 0, rep_commission_amount: 0, company_amount: l.amount,
            active: true, source: "payment_split", payment_id: pd.id,
          };
          const { data: ed } = await supabase.from("job_extras").insert([exPayload]).select("*").single();
          if (ed) {
            createdExtras.push(ed);
            if (!allocMissing) await supabase.from("payments").update({ job_extra_id: ed.id }).eq("id", pd.id);
          }
        }
      }
    }
    if (!err && unassigned > 0) {
      await insertRow({ ...base, amount: unassigned, concept: "on_account", notes: "A cuenta — sin imputar" });
    }
    // Two-way sync: job lines mirror bol_collected on the storage_job rows.
    if (!err && jobLineSum > 0 && f.job_id) {
      const k = jobKeyByRowId[Number(f.job_id)];
      const ids = k ? jobs.filter(j => jobKey(j) === k).map(j => j.id) : [];
      if (ids.length) await supabase.from("storage_jobs").update({ bol_collected: jobLineSum, bol_payment_method: f.method || null, bol_collected_date: f.payment_date || today(), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    }
    setPaySaving(false);
    if (err) { window.alert(err.message); return; }
    setShowPayModal(false); loadPayments(); loadJobs(); loadExtras();
    if (createdExtras.length) {
      const toAssign = [];
      for (const e of createdExtras) {
        if (window.confirm(`$${Math.round(numv(e.amount)).toLocaleString()} ${extraTypeLabel(e.extra_type)} recorded. Assign commission now?`)) toAssign.push(e);
      }
      if (toAssign.length) setCommAssign(commAssignInit(toAssign[0], toAssign.slice(1)));
    }
  }
  // Convert an "A cuenta" payment into allocated lines: the original row
  // becomes the first line (method/check/photo details preserved) and the
  // rest are inserted as siblings sharing its split_group.
  async function saveReallocation() {
    const p = reallocPay; if (!p) return;
    const { rows, unassigned, error: allocErr } = serializeAllocLines(payForm.alloc_lines, numv(p.amount));
    if (allocErr) { window.alert(allocErr); return; }
    if (!rows.length) { window.alert("Asigná al menos un monto a un cargo."); return; }
    setPaySaving(true);
    const lineFields = (l) => l.kind === "job" ? { concept: "job", extra_type: null, job_extra_id: null }
      : l.kind === "extra" ? { concept: "extra", extra_type: l.extra_type || null, job_extra_id: l.job_extra_id || null }
      : { concept: splitConcept(l.concept).pay, extra_type: splitConcept(l.concept).extra || null, job_extra_id: null };
    const needGroup = rows.length > 1 || unassigned > 0;
    const group = p.split_group || (needGroup ? ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : ("split-" + Date.now())) : null);
    const first = rows[0];
    const upd = { amount: first.amount, ...lineFields(first), notes: first.notes || p.notes || null };
    if (group && !splitMissing) upd.split_group = group;
    if (allocMissing) delete upd.job_extra_id;
    let { error: err } = await supabase.from("payments").update(upd).eq("id", p.id);
    // Siblings copy the money-movement facts of the original row.
    const sibling = { job_id: p.job_id, payment_date: p.payment_date, method: p.method || null, method_id: p.method_id || null,
      received: !!p.received, received_date: p.received_date || null, received_by: p.received_by || null,
      cash_with_whom: p.cash_with_whom || null, banked: !!p.banked, banked_date: p.banked_date || null, bank_account: p.bank_account || null,
      payment_stage: p.payment_stage || null, discount: 0 };
    let jobLineSum = first.concept === "job" || first.kind === "job" ? first.amount : 0;
    for (const l of rows.slice(1)) {
      if (err) break;
      const payload = { ...sibling, amount: l.amount, ...lineFields(l), notes: l.notes || null };
      if (group && !splitMissing) payload.split_group = group;
      if (allocMissing) delete payload.job_extra_id;
      ({ error: err } = await supabase.from("payments").insert([payload]));
      if (l.kind === "job") jobLineSum += l.amount;
    }
    if (!err && unassigned > 0) {
      const payload = { ...sibling, amount: unassigned, concept: "on_account", extra_type: null, notes: "A cuenta — sin imputar" };
      if (group && !splitMissing) payload.split_group = group;
      ({ error: err } = await supabase.from("payments").insert([payload]));
    }
    if (!err && jobLineSum > 0 && p.job_id) {
      const k = jobKeyByRowId[Number(p.job_id)];
      const ids = k ? jobs.filter(j => jobKey(j) === k).map(j => j.id) : [];
      if (ids.length) await supabase.from("storage_jobs").update({ bol_collected: jobLineSum, bol_payment_method: p.method || null, bol_collected_date: p.payment_date || today(), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    }
    setPaySaving(false);
    if (err) { window.alert(err.message); return; }
    setReallocPay(null); setEditingPayId(null); setShowPayModal(false); loadPayments(); loadJobs(); loadExtras();
  }
  async function savePaymentRow() {
    const f = payForm;
    if (reallocPay) { await saveReallocation(); return; }
    // Duplicate check / money-order serial → block with an explicit confirmation.
    const serialDup = f.method === "check" ? findCheckSerialDup(f.check_serial) : f.method === "money_order" ? findMoSerialDup(f.mo_serial) : null;
    if (serialDup && !window.confirm(`Number ${serialDup.serial} was already recorded ($${Math.round(serialDup.amount).toLocaleString()} on ${serialDup.date}, job ${serialDup.job_number}).\n\nThis serial number is already in the system. Are you sure you want to save a duplicate?`)) return;
    if (f.split_enabled && !editingPayId && !splitMissing) {
      if (!allocMissing && f.job_id && Array.isArray(f.alloc_lines)) { await saveAllocatedPayment(f); return; }
      await saveSplitPayment(f); return;
    }
    setPaySaving(true);
    const payload = payPayload(f);
    let mainId = editingPayId, error = null;
    if (editingPayId) ({ error } = await supabase.from("payments").update(payload).eq("id", editingPayId));
    else { const { data, error: insErr } = await supabase.from("payments").insert([payload]).select("id").single(); error = insErr; mainId = data?.id; }
    // Credit-card fee → keep a SEPARATE linked cc_fee payment record in sync.
    if (!error && !payColsMissing && mainId && f.concept !== "cc_fee") {
      const feeEnabled = f.method === "credit_card" && !!f.cc_fee_enabled;
      const feeAmt = feeEnabled ? (numv(f.amount) * numv(f.cc_fee_pct) / 100) : 0;
      const existingFeeId = f.cc_fee_payment_id ? Number(f.cc_fee_payment_id) : null;
      if (feeEnabled && feeAmt > 0) {
        const d = payload.payment_date || today();
        const feePayload = { job_id: payload.job_id, payment_date: d, amount: feeAmt, concept: "cc_fee", method: "credit_card", received: true, received_date: payload.received_date || d, banked: true, banked_date: payload.banked_date || d, received_by: payload.received_by || null };
        if (existingFeeId) await supabase.from("payments").update(feePayload).eq("id", existingFeeId);
        else { const { data: fd } = await supabase.from("payments").insert([feePayload]).select("id").single(); if (fd?.id) await supabase.from("payments").update({ cc_fee_payment_id: fd.id }).eq("id", mainId); }
      } else if (existingFeeId) {
        await supabase.from("payments").delete().eq("id", existingFeeId);
        await supabase.from("payments").update({ cc_fee_payment_id: null }).eq("id", mainId);
      }
    }
    // Two-way sync: a "job" payment mirrors bol_collected on the storage_job.
    if (!error && f.concept === "job" && f.job_id) {
      const k = jobKeyByRowId[Number(f.job_id)];
      const idsToSync = k ? jobs.filter(j => jobKey(j) === k).map(j => j.id) : [];
      if (idsToSync.length) {
        await supabase.from("storage_jobs").update({ bol_collected: numv(f.amount), bol_payment_method: f.method || null, bol_collected_date: f.payment_date || today(), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", idsToSync);
      }
    }
    setPaySaving(false);
    if (error) { window.alert(error.message); return; }
    setShowPayModal(false); loadPayments(); loadJobs();
  }
  // Mirror a job's recorded collection into the payments table (concept = "job"),
  // creating or updating a single canonical row. Called from the Settlement flow.
  async function upsertJobPayment(jobKeyStr, { amount, method, date }) {
    const rows = jobs.filter(j => jobKey(j) === jobKeyStr);
    if (!rows.length || numv(amount) <= 0) return;
    const repId = Math.min(...rows.map(r => r.id));
    const f = rows[0];
    const driverName = (Array.isArray(f.driver_ids) && f.driver_ids.length ? driverById[f.driver_ids[0]]?.name : "") || f.driver || "";
    const digital = isDigitalMethod(method);
    const banked = digital;
    const d = date || today();
    const payload = {
      job_id: repId, amount: numv(amount), concept: "job", method: method || null,
      payment_date: d, received: true, received_date: d,
      banked, banked_date: banked ? d : null,
      cash_with_whom: (isPhysical(method) && !banked) ? (driverName || null) : null,
    };
    const rowIds = new Set(rows.map(r => r.id));
    const existing = payments.find(p => p.concept === "job" && rowIds.has(p.job_id));
    if (existing) await supabase.from("payments").update(payload).eq("id", existing.id);
    else await supabase.from("payments").insert([payload]);
    loadPayments();
  }
  async function deletePaymentRow(p) {
    if (!window.confirm("Delete this payment?")) return;
    if (p.cc_fee_payment_id) await supabase.from("payments").delete().eq("id", p.cc_fee_payment_id);
    if (!extrasMissing && !splitMissing) await supabase.from("job_extras").delete().eq("payment_id", p.id);
    await supabase.from("payments").delete().eq("id", p.id); loadPayments(); loadExtras();
  }
  // Delete every payment row in a split group (and any extras / cc-fee children linked to them).
  async function deleteSplitGroup(rows) {
    if (!rows.length) return;
    if (!window.confirm(`Delete this split payment (${rows.length} lines)?`)) return;
    const ids = rows.map(r => r.id);
    const feeIds = rows.map(r => r.cc_fee_payment_id).filter(Boolean);
    if (!extrasMissing && !splitMissing) await supabase.from("job_extras").delete().in("payment_id", ids);
    if (feeIds.length) await supabase.from("payments").delete().in("id", feeIds);
    await supabase.from("payments").delete().in("id", ids);
    loadPayments(); loadExtras();
  }
  async function togglePayReceived(p) {
    const received = !p.received;
    await supabase.from("payments").update({ received, received_date: received ? (p.received_date || today()) : null }).eq("id", p.id);
    loadPayments();
  }
  async function togglePayBanked(p) {
    if (!p.received) return;  // can't bank what isn't received
    const banked = !p.banked;
    await supabase.from("payments").update({ banked, banked_date: banked ? (p.banked_date || today()) : null, cash_with_whom: banked ? null : p.cash_with_whom }).eq("id", p.id);
    loadPayments();
  }
  // Batch deposit from the "In circulation" tab: ticked payments become banked
  // in one shot, optionally tagged with the bank account they went into.
  async function depositSelected(ids) {
    if (!ids.length) return;
    const payload = { banked: true, banked_date: depositForm.date || today(), cash_with_whom: null };
    if (depositForm.bank_account) payload.bank_account = depositForm.bank_account;
    const { error } = await supabase.from("payments").update(payload).in("id", ids);
    if (error) { window.alert(error.message); return; }
    setDepositSel(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
    loadPayments();
  }
  function toggleDepositSel(id) {
    setDepositSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  // ── Bank accounts (payment_accounts) CRUD ──
  function openAddAccount() { setEditingAccountId(null); setAccountForm(EMPTY_PAY_ACCOUNT); setAccountFormOpen(true); }
  function openEditAccount(a) {
    setEditingAccountId(a.id);
    setAccountForm({ name:a.name || "", bank_name:a.bank_name || "", account_type:a.account_type || "", account_last4:a.account_last4 || "", notes:a.notes || "", active:a.active !== false });
    setAccountFormOpen(true);
  }
  async function savePayAccount() {
    const f = accountForm; if (!f.name.trim()) return;
    setAccountSaving(true);
    const payload = { name:f.name.trim(), bank_name:f.bank_name || null, account_type:f.account_type || null, account_last4:f.account_last4 || null, notes:f.notes || null, active:f.active !== false };
    let error;
    if (editingAccountId) ({ error } = await supabase.from("payment_accounts").update(payload).eq("id", editingAccountId));
    else ({ error } = await supabase.from("payment_accounts").insert([payload]));
    setAccountSaving(false);
    if (error) { window.alert(error.message); return; }
    setAccountFormOpen(false); setEditingAccountId(null); setAccountForm(EMPTY_PAY_ACCOUNT);
    loadPayAccounts();
  }
  async function toggleAccountActive(a) {
    await supabase.from("payment_accounts").update({ active: a.active === false }).eq("id", a.id);
    loadPayAccounts();
  }
  async function deletePayAccount(a) {
    // Payments reference the account by name (text), so accounts in use are
    // deactivated rather than deleted to keep history readable.
    if (payments.some(p => p.bank_account === a.name)) { window.alert("Esta cuenta está referenciada por pagos existentes. Desactivala en vez de borrarla."); return; }
    if (!window.confirm(`Delete account "${a.name}"?`)) return;
    await supabase.from("payment_accounts").delete().eq("id", a.id);
    loadPayAccounts();
  }
  function requestDepositWa(person) {
    const lines = person.items.map(p => `• Job ${p._g?.job_number || p.job_id || "—"} — $${p._net.toLocaleString()} (${payMethodLabel(p.method)})`).join("\n");
    const txt = `Hi ${person.name}, you currently have $${Math.round(person.total).toLocaleString()} in circulation:\n${lines}\nPlease deposit or deliver by end of week. Thank you.`;
    window.open("https://wa.me/?text=" + encodeURIComponent(txt), "_blank");
  }

  async function savePayment() {
    if (!payModal) return;
    const ids = jobs.filter(j => jobKey(j) === payModal.jobKey).map(j => j.id);
    if (!ids.length) { setPayModal(null); return; }
    await supabase.from("storage_jobs").update({
      bol_collected: numv(payModal.amount), bol_payment_method: payModal.method || null, bol_payment_notes: payModal.notes || null,
      bol_collected_date: payModal.date || today(), updated_by: userEmail, updated_at: new Date().toISOString(),
    }).in("id", ids);
    // Two-way sync: mirror this collection into the Payments table.
    if (!paymentsMissing) await upsertJobPayment(payModal.jobKey, { amount: payModal.amount, method: payModal.method, date: payModal.date });
    setPayModal(null);
    loadJobs();
  }
  async function uploadCsDoc(file, sheet) {
    if (!file) return;
    setDocUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      const path = `cs-${sheet?.id || "new"}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("closing-sheet-docs").upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (error) { window.alert("Upload error: " + error.message); setDocUploading(false); return; }
      const { data } = supabase.storage.from("closing-sheet-docs").getPublicUrl(path);
      const url = data?.publicUrl || "";
      if (sheet?.id) { await supabase.from("closing_sheets").update({ document_url: url }).eq("id", sheet.id); loadClosingSheets(); }
      else { setCsForm(f => ({ ...f, document_url: url })); }
    } catch (e) { window.alert("Error: " + e.message); }
    setDocUploading(false);
  }
  function exportCsPdf(sheet, calc, brokerNm, driverNm, jobsIn) {
    const m = (n) => `$${Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2})}`;
    const rows = jobsIn.map(j => `<tr><td>${j.job_number||"-"}</td><td>${j.customer||"-"}</td><td>${Math.round(parseCf(j.volume))} CF</td><td>${m(numv(j.carrier_rate_per_cf))}</td><td>${m(parseCf(j.volume)*numv(j.carrier_rate_per_cf))}</td><td>${m(numv(j.bol_balance))}</td><td>${m(numv(j.bol_collected))}</td></tr>`).join("");
    const net = calc.net >= 0 ? `Broker owes you ${m(calc.net)}` : `You owe the broker ${m(-calc.net)}`;
    const html = `<html><head><meta charset="utf-8"><title>CS ${sheet.closing_sheet_number||""}</title>
      <style>body{font-family:system-ui,sans-serif;padding:30px;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#f5f5f5}.box{border:1px solid #ddd;border-radius:8px;padding:12px;margin-top:10px}.r{display:flex;justify-content:space-between;font-size:13px;margin:3px 0}</style></head>
      <body><h1>Closing Sheet #${sheet.closing_sheet_number||"-"}</h1>
      <div>Broker: <b>${brokerNm||"-"}</b> · Driver: ${driverNm||"-"} · Load date: ${sheet.load_date||"-"} · Status: ${sheet.status}</div>
      <table><thead><tr><th>Job #</th><th>Client</th><th>CF</th><th>Rate/CF</th><th>Carrier fee</th><th>BOL balance</th><th>Collected</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="box"><div class="r"><span>Carrier fee subtotal</span><b>${m(calc.carrierFee)}</b></div>
      <div class="r"><span>− Trip cost</span><span>${m(numv(sheet.trip_cost))}</span></div>
      <div class="r"><span>− Labor</span><span>${m(numv(sheet.labor_charges))}</span></div>
      <div class="r"><span>− Other fees</span><span>${m(numv(sheet.other_fees))}</span></div>
      <div class="r"><span>− Pads (${calc.padsMissing})</span><span>${m(calc.padsCharge)}</span></div>
      <div class="r" style="border-top:1px solid #ddd;padding-top:6px;margin-top:6px"><span><b>Broker te debe</b></span><b>${m(calc.netCarrier)}</b></div></div>
      <div class="box"><div class="r"><span>BOL collected from clients</span><b>${m(calc.bolCollected)}</b></div><div class="r"><span>Pending collection</span><span>${m(calc.pending)}</span></div></div>
      <div class="box" style="text-align:center;font-size:16px;font-weight:700">${net}</div>
      </body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); }
  }

  // ── Capacity & billing handlers ──
  function openCapacity(target) { setCapTarget(target); }
  async function saveCapacity() {
    if (!capTarget) return;
    const val = capTarget.value !== "" ? Number(capTarget.value) : null;
    if (capTarget.kind === "unit") {
      await supabase.from("storages").update({ total_capacity_cf: val, space_type: "rented", updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", capTarget.id);
    } else if (capTarget.kind === "warehouse") {
      const existing = warehouseMeta[capTarget.name];
      if (existing) await supabase.from("storages").update({ total_capacity_cf: val, updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", existing.id);
      else await supabase.from("storages").insert([{ brand: capTarget.name, space_type: "warehouse", situation: "Open", total_capacity_cf: val, created_by: userEmail }]);
    }
    setCapTarget(null);
  }
  async function markBillingPaid(b) {
    if (!b?.id) return;
    await supabase.from("storage_billing").update({ status: "paid", paid_date: today() }).eq("id", b.id);
    loadBilling();
  }
  // Default billing start: first-month-free → date_in + 30, else date_in.
  function defaultBillingStart(job) {
    const di = job?.date_in || today();
    return job?.first_month_free ? addDaysStr(di, 30) : di;
  }
  function openAddBilling() {
    setBillingForm({ ...EMPTY_BILLING_FORM });
    setBillingJobSearch(""); setShowBillingModal(true);
  }
  // Edit the monthly rate / settings of an already-active billing client.
  function openEditBillingRate(c) {
    const job = c.job;
    setBillingForm({
      jobKey: c.jobKey, job_id: job.id, customer: c.customer, job_number: c.job_number,
      client_monthly_rate: job.client_monthly_rate ?? "", first_month_free: !!job.first_month_free,
      billing_start_date: job.billing_start_date || defaultBillingStart(job),
      billing_notes: job.billing_notes || "", editing: true,
    });
    setBillingJobSearch(""); setShowBillingModal(true);
  }
  // Pick a job in the Add-billing search; default rate/start from the job.
  function pickBillingJob(g) {
    const rep = jobs.filter(j => jobKey(j) === g.key)[0] || {};
    setBillingForm(f => ({
      ...f, jobKey: g.key, job_id: rep.id, customer: g.customer || "", job_number: g.job_number || "",
      client_monthly_rate: rep.client_monthly_rate ?? f.client_monthly_rate,
      first_month_free: f.first_month_free,
      billing_start_date: f.billing_start_date || defaultBillingStart(rep),
    }));
    setBillingJobSearch("");
  }
  async function saveBilling() {
    const f = billingForm;
    if (!f.jobKey) { window.alert("Pick a job first."); return; }
    setBillingSaving(true);
    const ids = jobs.filter(j => jobKey(j) === f.jobKey).map(j => j.id);
    const start = f.billing_start_date || defaultBillingStart(jobs.find(j => j.id === ids[0]) || {});
    const fields = {
      billing_active: true,
      client_monthly_rate: f.client_monthly_rate !== "" ? Number(f.client_monthly_rate) : null,
      first_month_free: !!f.first_month_free,
      billing_start_date: start || null,
      updated_by: userEmail, updated_at: new Date().toISOString(),
    };
    if (!billingNotesMissing) fields.billing_notes = f.billing_notes || null;
    if (ids.length) await supabase.from("storage_jobs").update(fields).in("id", ids);
    setBillingSaving(false); setShowBillingModal(false);
    showToast(f.editing ? "Billing updated" : "Billing activated");
    loadJobs(); loadBilling();
  }

  // Per-broker stats: active jobs count + pending balance (distinct jobs).
  const brokerStats = useMemo(() => {
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    const m = {};
    const seen = new Set();
    for (const j of jobs) {
      if (!j.broker_id) continue;
      const k = jobKey(j);
      if (!m[j.broker_id]) m[j.broker_id] = { jobs: new Set(), balance: 0 };
      m[j.broker_id].jobs.add(k);
      const sk = j.broker_id + "|" + k;
      if (!seen.has(sk) && !j.date_out && j.status !== "cancelled") {
        seen.add(sk);
        m[j.broker_id].balance += num(j.pickup_balance) + num(j.delivery_balance);
      }
    }
    return m;
  }, [jobs]);

  // Broker share kept per broker: job-balance share (by job, deduped) + extras share.
  const brokerShareByBroker = useMemo(() => {
    const m = {}; const seen = new Set();
    for (const j of jobs) {
      if (!j.broker_id) continue;
      const k = jobKey(j); const sk = j.broker_id + "|" + k;
      if (seen.has(sk)) continue; seen.add(sk);
      const collected = numv(j.bol_collected) || (numv(j.pickup_balance) + numv(j.delivery_balance));
      const share = j.broker_job_share_amount != null ? numv(j.broker_job_share_amount) : (collected * numv(j.broker_job_share_pct) / 100);
      if (share) m[j.broker_id] = (m[j.broker_id] || 0) + share;
    }
    for (const e of jobExtras) {
      if (e.active === false) continue;
      const k = jobKeyByRowId[e.job_id]; if (!k) continue;
      const g = extraJobGroups.get(k); const bid = g?.broker_id;
      if (!bid) continue;
      const share = extraBrokerShare(e);
      if (share) m[bid] = (m[bid] || 0) + share;
    }
    return m;
  }, [jobs, jobExtras, jobKeyByRowId, extraJobGroups]);


  // Mark every part of a job (all its units) as delivered.
  async function deliverJobs(ids) {
    if (!ids || !ids.length) return;
    await supabase.from("storage_jobs").update({ date_out: today(), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    loadJobs();
  }

  // Revert a delivery (e.g. marked by mistake): clears the delivery date.
  async function undeliverJobs(ids) {
    if (!ids || !ids.length) return;
    await supabase.from("storage_jobs").update({ date_out: null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    loadJobs();
  }

  // Quick-set the FADD on every part of a job (from the Dispatching table).
  async function setJobFadd(group, dateStr) {
    if (faddColMissing || !group?.parts?.length) return;
    await supabase.from("storage_jobs").update({ fadd: dateStr || null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", group.parts.map(p => p.id));
    loadJobs();
  }

  // Inline-edit a single job-level field across all parts of a job.
  async function updateJobField(parts, field, value) {
    if (!parts?.length) return;
    if (field === "fadd" && faddColMissing) return;
    await supabase.from("storage_jobs").update({ [field]: value || null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", parts.map(p => p.id));
    loadJobs();
  }

  async function deleteRecord(id) {
    if (!window.confirm("Delete this storage?")) return;
    await supabase.from("storages").delete().eq("id", id);
    setDetailId(null);
  }

  // Renew the payment: push the due date 30 days forward from its current value.
  async function renewPayment(r) {
    const base = paymentDueDate(r) || startOfToday();
    base.setDate(base.getDate() + 30);
    await supabase.from("storages").update({ payment_due_date: fmtDateLocal(base), updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", r.id);
  }

  // Close a storage: mark it Closed and clear its payment due date.
  async function closeStorage(r) {
    await supabase.from("storages").update({ situation: "Close", payment_due_date: null, updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", r.id);
    setDetailId(null);
  }

  function openImportModal() { setShowImport(true); setImportTab("paste"); setPasteText(""); setPending([]); setExcluded({}); setZipStatus(""); setZipName(""); }
  function previewPaste() { setPending(parsePastedMessages(pasteText)); setExcluded({}); }

  async function handleZip(file) {
    if (!file) return;
    setZipName(file.name); setZipStatus("Leyendo ZIP...");
    try {
      const { default: JSZip } = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
      const zip = await JSZip.loadAsync(file);
      let chatFile = Object.keys(zip.files).find(n => /chat.*\.txt$/i.test(n) && !zip.files[n].dir);
      if (!chatFile) chatFile = Object.keys(zip.files).find(n => /\.txt$/i.test(n) && !zip.files[n].dir);
      if (!chatFile) { setZipStatus("No .txt file found inside the ZIP."); return; }
      const text = await zip.files[chatFile].async("string");
      const parsed = parseWhatsAppExport(text);
      if (!parsed.length) { setZipStatus("No messages with storage data detected."); return; }
      setPending(parsed); setExcluded({});
      setZipStatus(`${parsed.length} storage(s) detectados en "${chatFile}".`);
    } catch (err) { setZipStatus("Error: " + err.message); }
  }

  async function confirmImport() {
    const toAdd = pending.filter((_, i) => !excluded[i]);
    if (!toAdd.length) return;
    setSaving(true);
    await supabase.from("storages").insert(toAdd);
    setSaving(false); setShowImport(false);
  }

  const tabStyle = (t) => ({ fontSize:13, fontWeight: tab === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: tab === t ? "#111" : "#999", borderBottom: tab === t ? "2px solid #111" : "2px solid transparent" });
  const impTabStyle = (t) => ({ flex:1, fontSize:13, padding:"8px", borderRadius:7, cursor:"pointer", border:"none", background: importTab === t ? "#fff" : "none", color: importTab === t ? "#111" : "#888", fontWeight: importTab === t ? 600 : 400, boxShadow: importTab === t ? "0 1px 4px rgba(0,0,0,0.08)" : "none" });

  if (session === undefined) return null;
  // Invite / password-reset landing: user arrived from an email link.
  if (pwRecovery) {
    if (!session) return null; // session still being established from the link token
    return <SetPasswordScreen onDone={() => { setPwRecovery(false); window.history.replaceState({}, "", window.location.pathname); }} />;
  }
  if (!session) return <LoginScreen />;
  if (profile === undefined) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, color:"#888", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ width:32, height:32, border:"3px solid #f0f0f0", borderTop:"3px solid #111", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontSize:14 }}>Loading…</span>
    </div>
  );
  if (profile && profile.active === false) return <DeactivatedScreen onSignOut={() => supabase.auth.signOut()} message="Your account is deactivated. Contact an administrator for access." />;
  // Signed in but no sections granted yet (no profile row, or empty permissions).
  const hasAnyAccess = isAdmin || SECTION_IDS.some(id => id === "users" ? isAdmin : can(id, "view"));
  if (!hasAnyAccess) return <DeactivatedScreen onSignOut={() => supabase.auth.signOut()} />;

  if (loading) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, color:"#888", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ width:32, height:32, border:"3px solid #f0f0f0", borderTop:"3px solid #111", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontSize:14 }}>Cargando storages...</span>
    </div>
  );

  if (error) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, color:"#b91c1c", fontFamily:"system-ui,sans-serif", padding:24 }}>
      <span style={{ fontSize:15, fontWeight:600 }}>Error de conexion</span>
      <span style={{ fontSize:13, color:"#888" }}>{error}</span>
      <button onClick={loadData} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", cursor:"pointer", fontSize:13 }}>Reintentar</button>
    </div>
  );

  return (
    <div style={{ fontFamily:"system-ui,-apple-system,sans-serif", color:"#111", display:"flex", minHeight:"100vh", background:"#fafafa" }}>
      <Sidebar page={page} setPage={setPage} onSignOut={() => supabase.auth.signOut()} badges={sidebarBadgesPlus} can={can} isAdmin={isAdmin} />
      <div style={{ flex:1, minWidth:0, padding:"20px 24px 40px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:18, flexWrap:"wrap" }}>
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <h1 style={{ fontSize:22, fontWeight:700, margin:0, letterSpacing:"-0.02em" }}>{PAGE_META[page].title}</h1>
            <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:20, background: liveIndicator ? "#EAF3DE" : "#f5f5f5", color: liveIndicator ? "#3B6D11" : "#aaa", transition:"all .3s" }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background: liveIndicator ? "#639922" : "#ccc", transition:"all .3s" }} />
              {liveIndicator ? "Actualizado" : "Live"}
            </span>
          </div>
          <div style={{ fontSize:13, color:"#999", marginTop:2 }}>{PAGE_META[page].sub}</div>
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          {(() => {
            // Per-section duplicate alert: shown top-right only when this section has duplicates.
            const dupSection = page === "jobs" ? "jobs" : page === "payments" ? "payments" : page === "storage" ? "storages" : null;
            const n = dupSection ? duplicateReport[dupSection].length : 0;
            if (!dupSection || n === 0) return null;
            return (
              <button onClick={() => { setDupFocus(dupSection); setShowDupModal(true); }} title="Review possible duplicates" style={{ padding:"8px 12px", borderRadius:8, border:"1px solid #F4DDB0", background:"#FFF6E8", color:"#B45309", fontSize:13, fontWeight:700, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:6 }}>
                🔍 {n} duplicate{n === 1 ? "" : "s"}
              </button>
            );
          })()}
          {page === "storage" && can("storage","create") && <Btn onClick={openImportModal}>Importar WhatsApp</Btn>}
          {page === "storage" && can("storage","create") && <Btn onClick={openAdd}>+ Unit</Btn>}
          {page === "storage" && storageTab === "storage_units" && can("storage","create") && <Btn disabled={!dbReady} onClick={openUnitJobPicker}>+ Job a unidad</Btn>}
          {page === "drivers" && can("drivers","create") && <Btn primary disabled={crmV3Missing} onClick={openAddDriver}>+ Driver</Btn>}
          {page === "brokers" && can("brokers","create") && <Btn primary disabled={crmV2Missing} onClick={openAddBroker}>+ Broker</Btn>}
          {page === "settlements" && !csDetailId && can("settlements","create") && <Btn primary disabled={settlementsMissing} onClick={openAddCs}>+ Closing sheet</Btn>}
          {page === "trips" && can("trips","create") && <Btn disabled={tripsMissing || tripAILoading} onClick={requestTripSuggestions}>✨ Suggest trips (AI)</Btn>}
          {page === "trips" && can("trips","create") && <Btn primary disabled={tripsMissing} onClick={openAddTrip}>+ Trip</Btn>}
          {page === "trucks" && can("trucks","create") && <Btn primary disabled={tripsMissing} onClick={openAddTruck}>+ Truck</Btn>}
          {page === "equipment" && can("equipment","create") && <Btn primary disabled={equipmentMissing} onClick={() => { setEditingEquipmentId(null); setEquipmentForm(EMPTY_EQUIPMENT); setShowEquipmentModal(true); }}>+ Item</Btn>}
          {page === "extras" && can("extras","create") && <Btn disabled={extrasMissing} onClick={() => { setEmpForm(EMPTY_EMPLOYEE); setShowEmpModal(true); }}>Reps / Employees</Btn>}
          {page === "payments" && can("payments","create") && <Btn disabled={paymentsMissing} onClick={() => setShowAccountsModal(true)}>🏦 Bank accounts</Btn>}
          {page === "payments" && can("payments","create") && !paymentsMissing && !extrasMissing && <Btn onClick={openAddExtraFromPayments}>+ Extra</Btn>}
          {page === "payments" && can("payments","create") && <Btn primary disabled={paymentsMissing} onClick={() => openAddPayment()}>+ Payment</Btn>}
          {page === "compliance" && can("compliance","create") && <><Btn disabled={complianceMissing} onClick={() => openAddDoc()}>+ Document</Btn><Btn primary disabled={complianceMissing} onClick={openAddCompany}>+ Company</Btn></>}
          {page === "billing" && can("billing","create") && <Btn primary disabled={billingMissing} onClick={openAddBilling}>+ Add billing</Btn>}
          {(page === "dispatching" || page === "jobs" || page === "calendario" || page === "calendario_entregas") && (can("jobs","create") || can("dispatching","create") || can("calendario","create") || can("calendario_entregas","create")) && <Btn primary disabled={!dbReady} onClick={() => openAddJob("")}>+ New job</Btn>}
        </div>
      </div>

      {dbSetupNeeded && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>El historial de jobs por unidad necesita crear la tabla <strong>storage_jobs</strong> una sola vez.</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver instrucciones</button>
        </div>
      )}

      {paymentColMissing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B" }}>
          To track payments, add the column once in Supabase (SQL Editor):
          <code style={{ display:"block", marginTop:6, fontFamily:"monospace", fontSize:12 }}>alter table public.storages add column if not exists payment_due_date date;</code>
        </div>
      )}

      {faddColMissing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B" }}>
          For FADD / Dispatching, add the column once in Supabase (SQL Editor):
          <code style={{ display:"block", marginTop:6, fontFamily:"monospace", fontSize:12 }}>alter table public.storage_jobs add column if not exists fadd date;</code>
        </div>
      )}

      {driverColMissing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B" }}>
          Para asignar el driver que abre cada unit, agregá la columna una vez en Supabase (SQL Editor):
          <code style={{ display:"block", marginTop:6, fontFamily:"monospace", fontSize:12 }}>alter table public.storages add column if not exists driver_id bigint;</code>
        </div>
      )}

      {jobColsMissing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B" }}>
          For the Dispatching CRM (job type, statuses, pickup/delivery), add these columns once in Supabase (SQL Editor):
          <code style={{ display:"block", marginTop:6, fontFamily:"monospace", fontSize:12, whiteSpace:"pre-wrap" }}>{JOB_COLS_SQL}</code>
        </div>
      )}

      {crmV2Missing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>For Brokers and pickup/delivery balances, run this SQL once in Supabase (SQL Editor).</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
        </div>
      )}

      {billingMissing && page !== "billing" && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>For Billing and storage occupancy (CF capacity), run the setup SQL once in Supabase.</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
        </div>
      )}

      {crmV3Missing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>For Drivers, multi-assignment, rep and the new financial fields, run the setup SQL once in Supabase.</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
        </div>
      )}

      {page === "storage" && duePaymentsSoon.length > 0 && !storageBannerDismissed && (
        <div style={{ background:"#FCEBEB", border:"1px solid #E24B4A", borderRadius:10, padding:"12px 14px", marginBottom:16, fontSize:13, color:"#A32D2D", display:"flex", alignItems:"flex-start", gap:10 }}>
          <div style={{ flex:1 }}>
            <strong>⚠️ {duePaymentsSoon.length} payment(s) due in 3 days or less:</strong>
            <div style={{ marginTop:6, display:"flex", flexWrap:"wrap", gap:8 }}>
              {duePaymentsSoon.map(p => (
                <span key={p.id} onClick={() => setDetailId(p.id)} style={{ background:"#fff", border:"1px solid #f3c9c9", borderRadius:20, padding:"3px 10px", cursor:"pointer", whiteSpace:"nowrap" }}>
                  {p.label} · {p.days < 0 ? "overdue" : p.days === 0 ? "today" : `${p.days}d`}
                </span>
              ))}
            </div>
          </div>
          <button onClick={() => setStorageBannerDismissed(true)} title="Dismiss" style={{ background:"none", border:"none", fontSize:18, lineHeight:1, cursor:"pointer", color:"#A32D2D", flexShrink:0 }}>×</button>
        </div>
      )}

      {/* ───────────────────────── USERS (admin) ───────────────────────── */}
      {page === "users" && isAdmin && <UsersSection session={session} />}

      {/* ───────────────────────── MESSAGES (team chat) ───────────────────────── */}
      {page === "messages" && can("messages","view") && <MessagesSection supabase={supabase} session={session} profile={profile} isAdmin={isAdmin} onlineIds={onlineIds} onUnreadTotal={setChatUnread} />}

      {/* ───────────────────────── SUGGESTIONS (employee feedback) ───────────────────────── */}
      {page === "suggestions" && <SuggestionsSection supabase={supabase} session={session} profile={profile} isAdmin={isAdmin} />}

      {page === "bol" && can("bol","view") && <BolSection supabase={supabase} session={session} jobs={jobs} brokers={brokers} can={can} isAdmin={isAdmin} initialJobNumber={bolJobNumber} onConsumed={() => setBolJobNumber(null)} />}

      {/* ───────────────────────── DISPATCHING ───────────────────────── */}
      {page === "dispatching" && (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10, marginBottom:16 }}>
            {[
              { label:"Pickups today", value:dispatchMetrics.pickups, color:"#185FA5" },
              { label:"Deliveries today", value:dispatchMetrics.deliveries, color:"#3B6D11" },
              { label:"FADD overdue", value:faddStats.overdue, color:"#A32D2D" },
              { label:"FADD this week", value:faddStats.dueWeek, color:"#C2410C" },
              { label:"In storage", value:dispatchMetrics.inStorage, color:"#7C3AED" },
              { label:"Balance pickup pend.", value:"$"+dispatchMetrics.puBal.toLocaleString(), color:"#1A8A4E" },
              { label:"Balance delivery pend.", value:"$"+dispatchMetrics.delBal.toLocaleString(), color:"#1A8A4E" },
              { label:"Billing overdue", value:billingOverdueCount, color:"#A32D2D" },
            ].map(m => (
              <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                <div style={{ fontSize:11, color:"#aaa", fontWeight:500, marginBottom:4 }}>{m.label}</div>
                <div style={{ fontSize:22, fontWeight:700, color:m.color }}>{m.value}</div>
              </div>
            ))}
          </div>

          {duplicateReport.total > 0 && (
            <div onClick={() => { setDupFocus(null); setShowDupModal(true); }} style={{ background:"#FFF6E8", border:"1px solid #F4DDB0", borderRadius:10, padding:"10px 14px", marginBottom:14, fontSize:13, color:"#B45309", display:"flex", alignItems:"center", gap:8, cursor:"pointer", flexWrap:"wrap" }}>
              <span style={{ fontSize:16 }}>🔍</span>
              <b>{duplicateReport.total} posible{duplicateReport.total === 1 ? "" : "s"} duplicate{duplicateReport.total === 1 ? "" : "s"}</b>
              <span style={{ color:"#a07d3a" }}>· Jobs {duplicateReport.jobs.length} · Payments {duplicateReport.payments.length} · Storages {duplicateReport.storages.length}</span>
              <span style={{ marginLeft:"auto", textDecoration:"underline", fontWeight:600 }}>Revisar →</span>
            </div>
          )}

          {dispatchAlerts.length > 0 && !bannerDismissed && (
            <div style={{ background:"#FCEBEB", border:"1px solid #E24B4A", borderRadius:10, padding:"12px 14px", marginBottom:14, fontSize:13, color:"#A32D2D", display:"flex", alignItems:"flex-start", gap:10 }}>
              <div style={{ flex:1 }}>
                <strong>⚠️ {dispatchAlerts.length} job(s) need attention:</strong>
                <div style={{ marginTop:6, display:"flex", flexWrap:"wrap", gap:8 }}>
                  {dispatchAlerts.map(a => (
                    <span key={a.key} onClick={() => setJobDetailKey(a.key)} style={{ background:"#fff", border:"1px solid #f3c9c9", borderRadius:20, padding:"3px 10px", cursor:"pointer", whiteSpace:"nowrap" }}>
                      <strong style={{ fontFamily:"monospace" }}>{a.job_number || "(job)"}</strong> · {a.customer || "—"} · {a.reason}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => setBannerDismissed(true)} title="Dismiss" style={{ background:"none", border:"none", fontSize:18, lineHeight:1, cursor:"pointer", color:"#A32D2D", flexShrink:0 }}>×</button>
            </div>
          )}

          <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
            {[["all","All"],["pickups_today","Pickups today"],["deliveries_today","Deliveries today"],["in_storage","In storage"],["on_hold","On hold"],["no_trip","No trip assigned"],["nofadd","No FADD"],["no_delivery","Sin delivery"]].map(([t,l]) => (
              <button key={t} onClick={() => setDispatchFilter(t)}
                style={{ fontSize:13, fontWeight: dispatchFilter === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: dispatchFilter === t ? "#111" : "#999", borderBottom: dispatchFilter === t ? "2px solid #111" : "2px solid transparent" }}>{l}</button>
            ))}
          </div>

          <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by job #, client, driver, pickup, delivery..."
              style={{ ...inp, flex:1, minWidth:180 }} />
            <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={{ ...inp, minWidth:150 }}>
              <option value="">All drivers</option>
              {drivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["Status","Job #","Type","Broker","Rep","Client","FADD","Pickup","Delivery","CF","Sticker","Driver","Trip","Bal. pickup","Bal. delivery","Storage","Actions"].map((h, i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dispatchGroups.length === 0 ? (
                    <tr><td colSpan={17} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>No jobs to dispatch in this filter.</td></tr>
                  ) : dispatchGroups.map(g => {
                    const stores = [...new Set(g.parts.map(p => p.warehouse ? `Warehouse ${p.warehouse}` : [p.storage?.brand, p.storage?.unit && "U"+p.storage.unit, p.storage?.state].filter(Boolean).join(" ")).filter(Boolean))];
                    const storeLabel = stores.join(" · ");
                    const mapHref = routeUrl(g);
                    const ns = nextStatus(g);
                    const gTrip = g.trip_id ? tripById[g.trip_id] : null;
                    const waHref = (gTrip && TRIP_ACTIVE(gTrip.status))
                      ? (() => { const tc = tripCalc(gTrip); return tripManifestLink(gTrip, truckById[gTrip.truck_id]?.name, driverById[gTrip.driver_id]?.name, tc.jobsIn, tc.loadedCf, tc.occPct, tc.totalCollect); })()
                      : waLink(g, storeLabel, brokerName(g.broker_id), jobGroupLink(g));
                    const pickupAddr = [g.pickup_address, [g.pickup_city, g.pickup_state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
                    const deliveryAddr = [g.delivery_address, [g.delivery_city, g.delivery_state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
                    return (
                    <tr key={g.key} style={{ borderBottom:"1px solid #fafafa", verticalAlign:"top" }}>
                      <td style={{ padding:"12px" }}><StatusBadge status={g.status} /></td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                        <span style={{ display:"inline-flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                          {!g.sticker_color && <span title="Sticker unassigned" style={{ cursor:"help" }}>⚠️</span>}
                          <button onClick={() => setJobDetailKey(g.key)} style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{g.job_number || "(ver)"}</button>
                          {g.job_type === "broker_delivery" && (g.status === "delivered" || g.parts?.some(p => p.date_out)) && numv(g.bol_collected) < numv(g.bol_balance) && numv(g.bol_balance) > 0 && (
                            <span title="BOL collection pending" style={{ fontSize:9.5, fontWeight:700, color:"#C2410C", background:"#FDE3CF", borderRadius:10, padding:"1px 6px" }}>Collection pending</span>
                          )}
                          {jobKeysWithExtras.has(g.key) && (
                            <span title="Tiene extras registrados" style={{ fontSize:9.5, fontWeight:700, color:"#6D28D9", background:"#EDE9FE", borderRadius:10, padding:"1px 6px" }}>Extras</span>
                          )}
                          {!paymentsMissing && (() => {
                            const outstanding = numv(g.pickup_balance) + numv(g.delivery_balance) + numv(g.bol_balance) - (jobReceivedByKey[g.key] || 0);
                            if (outstanding <= 0) return null;
                            const delivered = g.status === "delivered" || g.parts?.some(p => p.date_out);
                            return delivered
                              ? <span title={`Delivered, not collected · $${Math.round(outstanding).toLocaleString()}`} style={{ fontSize:9.5, fontWeight:700, color:"#B91C1C", background:"#FEE2E2", borderRadius:10, padding:"1px 6px" }}>Not collected</span>
                              : <span title={`Outstanding balance · $${Math.round(outstanding).toLocaleString()}`} style={{ fontSize:9.5, fontWeight:700, color:"#C2410C", background:"#FDE3CF", borderRadius:10, padding:"1px 6px" }}>Outstanding</span>;
                          })()}
                        </span>
                      </td>
                      <td style={{ padding:"12px" }}><TypeBadge type={g.job_type} /></td>
                      <td style={{ padding:"12px", fontSize:12, whiteSpace:"nowrap" }}>{brokerName(g.broker_id) || "—"}</td>
                      <td style={{ padding:"12px", fontSize:12, whiteSpace:"nowrap" }}>{g.rep || "—"}</td>
                      <td style={{ padding:"12px" }}>{g.customer||"—"}</td>
                      <td style={{ padding:"12px" }}><FaddCell group={g} onSet={setJobFadd} /></td>
                      <td style={{ padding:"12px", fontSize:12, minWidth:130 }}>
                        <div style={{ fontWeight:600 }}>{(() => { const f = g.pickup_date_from || g.pickup_date; if (!f) return "—"; const t = g.pickup_date_to; return t && t !== f ? `${f} → ${t}` : f; })()}</div>
                        {pickupAddr && <div style={{ color:"#888", marginTop:2 }}>{pickupAddr}</div>}
                      </td>
                      <td style={{ padding:"12px", fontSize:12, minWidth:130 }}>
                        <div style={{ fontWeight:600 }}>{g.delivery_date || "—"}</div>
                        {deliveryAddr && <div style={{ color:"#888", marginTop:2 }}>{deliveryAddr}</div>}
                      </td>
                      <td style={{ padding:"12px" }}>{g.volume||"—"}</td>
                      <td style={{ padding:"12px" }}>
                        <Sticker color={g.sticker_color} />
                        {g.lot_number && <div style={{ fontFamily:"monospace", fontSize:11, color:"#888", marginTop:2 }}>{g.lot_number}</div>}
                      </td>
                      <td style={{ padding:"12px" }}>{jobDriverNames(g)||"—"}</td>
                      <td style={{ padding:"12px", fontSize:12, whiteSpace:"nowrap" }}>
                        {gTrip
                          ? <button onClick={() => setPage("trips")} style={{ fontFamily:"monospace", fontSize:11.5, fontWeight:600, color:"#6D28D9", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{gTrip.trip_number || ("#"+gTrip.id)}</button>
                          : <span style={{ color:"#bbb" }}>— Unassigned —</span>}
                      </td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:600, color: money(g.pickup_balance) ? "#1A8A4E" : "#bbb" }}>{money(g.pickup_balance) || "—"}</td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:600, color: money(g.delivery_balance) ? "#1A8A4E" : "#bbb" }}>{money(g.delivery_balance) || "—"}</td>
                      <td style={{ padding:"12px", fontSize:12, color:"#555" }}>
                        {stores.length ? stores.map((s, i) => <div key={i} style={{ marginBottom: i < stores.length-1 ? 3 : 0 }}>{s}</div>) : "—"}
                      </td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                        <div style={{ display:"flex", flexDirection:"column", gap:5, alignItems:"flex-start" }}>
                          {mapHref && <a href={mapHref} target="_blank" rel="noreferrer" style={{ color:"#185FA5", textDecoration:"none", fontSize:12 }}>🗺️ Ruta</a>}
                          <a href={waHref} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E", textDecoration:"none", fontSize:12 }}>💬 WhatsApp</a>
                          {ns && <Btn onClick={() => advanceStatus(g)} style={{ padding:"4px 9px", fontSize:11 }}>→ {statusMeta(ns).l}</Btn>}
                          <button onClick={() => deleteJob(g)} title="Delete job" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:14, padding:0, alignSelf:"flex-start" }}>🗑 Delete</button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{dispatchGroups.length} job(s)</div>
          </div>
        </>
      )}

      {/* ───────────────────────── CALENDARIO ───────────────────────── */}
      {page === "calendario" && (() => {
        const range = calView === "week" ? weekDays(calAnchor) : null;
        const grid = calView === "month" ? monthGrid(calAnchor) : null;
        const anchorD = new Date(calAnchor + "T00:00:00");
        const title = calView === "week"
          ? (() => { const w = weekDays(calAnchor); return `${w[0]} → ${w[6]}`; })()
          : `${MONTHS_ES[anchorD.getMonth()]} ${anchorD.getFullYear()}`;
        const step = calView === "week" ? 7 : 30;
        const Event = ({ g }) => {
          const c = calEventColor(g);
          const route = [g.pickup_state, g.delivery_state].filter(Boolean).join(" to ");
          const drv = jobDriverNames(g);
          return (
            <div onClick={() => setJobDetailKey(g.key)} title={`${g.job_number || ""} ${g.customer || ""}`}
              style={{ background:c.bg, color:c.text, borderLeft:`3px solid ${c.bar}`, borderRadius:5, padding:"3px 6px", marginBottom:4, cursor:"pointer", fontSize:10.5, lineHeight:1.3 }}>
              <div style={{ fontWeight:700, fontFamily:"monospace" }}>{g.job_number || "(job)"}</div>
              {route && <div>{route}</div>}
              {drv && <div style={{ opacity:0.85 }}>🧑‍✈️ {drv}</div>}
            </div>
          );
        };
        return (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
              <Btn onClick={() => setCalAnchor(shiftDate(calAnchor, -step))}>←</Btn>
              <Btn onClick={() => setCalAnchor(today())}>Today</Btn>
              <Btn onClick={() => setCalAnchor(shiftDate(calAnchor, step))}>→</Btn>
              <strong style={{ fontSize:15, marginLeft:6 }}>{title}</strong>
              <span style={{ flex:1 }} />
              <Btn onClick={() => openCalAddExisting("")}>➕ Add existing job</Btn>
              <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3 }}>
                {[["week","Week"],["month","Month"]].map(([v,l]) => (
                  <button key={v} onClick={() => setCalView(v)} style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: calView===v?"#fff":"none", color: calView===v?"#111":"#888", fontWeight: calView===v?600:400, boxShadow: calView===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
                ))}
              </div>
            </div>

            <div style={{ display:"flex", gap:10, marginBottom:12, flexWrap:"wrap", fontSize:11, color:"#666" }}>
              {[["#639922","Active"],["#FACC15","On hold / Redispatch"],["#E24B4A","Cancelled"],["#7C3AED","Long haul"],["#378ADD","Delivered"]].map(([c,l]) => (
                <span key={l} style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:3, background:c }} />{l}</span>
              ))}
            </div>

            {calView === "week" ? (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:8 }}>
                {range.map(ds => {
                  const d = new Date(ds + "T00:00:00");
                  const evs = pickupEvents[ds] || [];
                  const isToday = ds === today();
                  return (
                    <div key={ds} style={{ background:"#fff", border:`1px solid ${isToday?"#378ADD":"#efefef"}`, borderRadius:10, minHeight:160, display:"flex", flexDirection:"column" }}>
                      <div onClick={() => setCalDayMenu(ds)} title="Add to this day" style={{ padding:"7px 9px", borderBottom:"1px solid #f3f3f3", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ fontSize:11, fontWeight:600 }}>{DOW_ES[d.getDay()]} {d.getDate()}</span>
                        <span style={{ color:"#bbb", fontSize:13 }}>+</span>
                      </div>
                      <div style={{ padding:7, flex:1 }}>{evs.map(g => <Event key={g.key} g={g} />)}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ background:"#fff", border:"1px solid #efefef", borderRadius:10, overflow:"hidden" }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)" }}>
                  {DOW_ES.map(d => <div key={d} style={{ padding:"8px 6px", textAlign:"center", fontSize:10, fontWeight:700, color:"#aaa", textTransform:"uppercase", borderBottom:"1px solid #efefef" }}>{d}</div>)}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)" }}>
                  {grid.map(({ date, inMonth }) => {
                    const d = new Date(date + "T00:00:00");
                    const evs = pickupEvents[date] || [];
                    const isToday = date === today();
                    return (
                      <div key={date} style={{ borderRight:"1px solid #f4f4f4", borderBottom:"1px solid #f4f4f4", minHeight:96, padding:5, background: inMonth?"#fff":"#fafafa", opacity: inMonth?1:0.6 }}>
                        <div onClick={() => setCalDayMenu(date)} title="Add to this day" style={{ cursor:"pointer", fontSize:10.5, fontWeight:600, color: isToday?"#185FA5":"#666", marginBottom:3 }}>{d.getDate()}</div>
                        {evs.slice(0,3).map(g => <Event key={g.key} g={g} />)}
                        {evs.length > 3 && <div style={{ fontSize:9, color:"#999" }}>+{evs.length-3} more</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Calendar: "what do you want to add to this day?" menu */}
      {calDayMenu && (
        <Modal title={`Add to ${calDayMenu}`} onClose={() => setCalDayMenu(null)}
          footer={<><Btn onClick={() => setCalDayMenu(null)}>Cancel</Btn></>}>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            <Btn primary onClick={() => { const d = calDayMenu; setCalDayMenu(null); openAddJobDate(d); }} style={{ justifyContent:"center", padding:"12px" }}>🆕 Create new job on this day</Btn>
            <Btn onClick={() => openCalAddExisting(calDayMenu)} style={{ justifyContent:"center", padding:"12px" }}>📋 Add an existing job to this day</Btn>
          </div>
        </Modal>
      )}

      {/* Calendar: search existing jobs (no pickup date yet) and put them on a date */}
      {calAddExisting && (() => {
        const q = calAddSearch.trim().toLowerCase();
        const seen = new Set(); const results = [];
        for (const j of jobs) {
          if (j.pickup_date_from || j.pickup_date) continue;       // only jobs not on the calendar yet
          if (j.date_out || j.status === "cancelled") continue;    // skip closed/cancelled jobs
          const k = jobKey(j); if (seen.has(k)) continue; seen.add(k);
          const names = jobDriverNames(j);
          const hay = [j.job_number, j.customer, j.driver, names].filter(Boolean).join(" ").toLowerCase();
          if (q && !hay.includes(q)) continue;
          results.push({ key:k, job_number:j.job_number, customer:j.customer, status:j.status, drivers:names });
        }
        const shown = results.slice(0, 60);
        return (
          <Modal title="Add existing job to calendar" onClose={() => setCalAddExisting(null)}
            footer={<><Btn onClick={() => setCalAddExisting(null)}>Close</Btn></>}>
            <div style={{ display:"flex", gap:10, alignItems:"flex-end", flexWrap:"wrap", marginBottom:10 }}>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Pickup date</label>
                <input style={inp} type="date" value={calAddDate} onChange={e => setCalAddDate(e.target.value)} />
              </div>
              <div style={{ flex:1, minWidth:180, display:"flex", flexDirection:"column", gap:3 }}>
                <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Search</label>
                <input style={inp} value={calAddSearch} onChange={e => setCalAddSearch(e.target.value)} placeholder="Search job # / client / driver…" autoFocus />
              </div>
            </div>
            <div style={{ fontSize:11.5, color:"#999", marginBottom:8 }}>Only jobs without a pickup date are listed. Pick a date above, then click a job to put it on the calendar.</div>
            <div style={{ border:"1px solid #eee", borderRadius:9, maxHeight:340, overflowY:"auto", background:"#fff" }}>
              {shown.length === 0 ? (
                <div style={{ padding:"16px", fontSize:12.5, color:"#bbb", textAlign:"center" }}>{q ? "No matching jobs without a pickup date." : "No jobs pending a pickup date."}</div>
              ) : shown.map(g => (
                <div key={g.key} onClick={() => addExistingJobToCalendar(g, calAddDate)}
                  style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", borderBottom:"1px solid #f6f6f6", cursor:"pointer", fontSize:12.5 }}
                  onMouseEnter={e => e.currentTarget.style.background = "#f7faf1"} onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div><b style={{ fontFamily:"monospace" }}>{g.job_number || "(no #)"}</b> · {g.customer || "—"}</div>
                    <div style={{ color:"#999", marginTop:2, display:"flex", gap:8, flexWrap:"wrap" }}>
                      <StatusBadge status={g.status} />{g.drivers && <span>🧑‍✈️ {g.drivers}</span>}
                    </div>
                  </div>
                  <Btn primary style={{ padding:"5px 11px", fontSize:12 }} onClick={(e) => { e.stopPropagation(); addExistingJobToCalendar(g, calAddDate); }}>Add</Btn>
                </div>
              ))}
            </div>
          </Modal>
        );
      })()}

      {/* ───────────────────── DELIVERY CALENDAR ───────────────────── */}
      {page === "calendario_entregas" && (() => {
        const range = dcalView === "week" ? weekDays(dcalAnchor) : null;
        const grid = dcalView === "month" ? monthGrid(dcalAnchor) : null;
        const anchorD = new Date(dcalAnchor + "T00:00:00");
        const title = dcalView === "week"
          ? (() => { const w = weekDays(dcalAnchor); return `${w[0]} → ${w[6]}`; })()
          : `${MONTHS_ES[anchorD.getMonth()]} ${anchorD.getFullYear()}`;
        const step = dcalView === "week" ? 7 : 30;
        const Event = ({ g }) => {
          const c = calEventColor(g);
          const route = [g.pickup_state, g.delivery_state].filter(Boolean).join(" to ");
          const drv = jobDriverNames(g);
          return (
            <div onClick={() => setJobDetailKey(g.key)} title={`${g.job_number || ""} ${g.customer || ""}`}
              style={{ background:c.bg, color:c.text, borderLeft:`3px solid ${c.bar}`, borderRadius:5, padding:"3px 6px", marginBottom:4, cursor:"pointer", fontSize:10.5, lineHeight:1.3 }}>
              <div style={{ fontWeight:700, fontFamily:"monospace" }}>{g.job_number || "(job)"}{g.job_type === "broker_delivery" && <span style={{ fontWeight:600, opacity:0.8 }}> · Broker</span>}</div>
              {route && <div>{route}</div>}
              {drv && <div style={{ opacity:0.85 }}>🧑‍✈️ {drv}</div>}
            </div>
          );
        };
        return (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
              <Btn onClick={() => setDcalAnchor(shiftDate(dcalAnchor, -step))}>←</Btn>
              <Btn onClick={() => setDcalAnchor(today())}>Today</Btn>
              <Btn onClick={() => setDcalAnchor(shiftDate(dcalAnchor, step))}>→</Btn>
              <strong style={{ fontSize:15, marginLeft:6 }}>{title}</strong>
              <span style={{ flex:1 }} />
              <Btn onClick={() => openDcalAddExisting("")}>➕ Add existing job</Btn>
              <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3 }}>
                {[["week","Week"],["month","Month"]].map(([v,l]) => (
                  <button key={v} onClick={() => setDcalView(v)} style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: dcalView===v?"#fff":"none", color: dcalView===v?"#111":"#888", fontWeight: dcalView===v?600:400, boxShadow: dcalView===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
                ))}
              </div>
            </div>

            <div style={{ display:"flex", gap:10, marginBottom:12, flexWrap:"wrap", fontSize:11, color:"#666" }}>
              {[["#639922","Active"],["#FACC15","On hold / Redispatch"],["#E24B4A","Cancelled"],["#7C3AED","Long haul"],["#378ADD","Delivered"]].map(([c,l]) => (
                <span key={l} style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:3, background:c }} />{l}</span>
              ))}
            </div>

            {/* Jobs picked up & waiting (or broker deliveries) with no delivery date yet. */}
            {deliveryCandidates.length > 0 && (
              <div style={{ background:"#fff", border:"1px solid #F4DDB0", borderRadius:10, marginBottom:14, overflow:"hidden" }}>
                <div onClick={() => setDcalPanelOpen(o => !o)} style={{ padding:"10px 14px", cursor:"pointer", display:"flex", alignItems:"center", gap:8, background:"#FFF9EE" }}>
                  <span style={{ fontSize:13, fontWeight:700, color:"#854F0B" }}>📋 Entregas por agendar ({deliveryCandidates.length})</span>
                  {deliveryToSchedule > 0 && <span style={{ fontSize:10.5, fontWeight:700, background:"#E24B4A", color:"#fff", borderRadius:10, padding:"1px 7px" }}>{deliveryToSchedule} con FADD ≤ 7 días</span>}
                  <span style={{ flex:1 }} />
                  <span style={{ color:"#B58B3D", fontSize:12 }}>{dcalPanelOpen ? "▾ ocultar" : "▸ mostrar"}</span>
                </div>
                {dcalPanelOpen && (
                  <>
                    {deliveryCandidates.slice(0, 10).map(c => (
                      <ScheduleDeliveryRow key={c.key} cand={c}
                        onOpen={setJobDetailKey}
                        onSchedule={(cand, date) => { setJobDelivery(cand.ids, date); showToast(`Entrega de ${cand.job_number || "job"} agendada para ${date}`.replace(/\s+/g, " ").trim()); }} />
                    ))}
                    {deliveryCandidates.length > 10 && (
                      <div style={{ padding:"8px 14px", fontSize:11.5, color:"#999" }}>
                        +{deliveryCandidates.length - 10} más — <button onClick={() => openDcalAddExisting("")} style={{ border:"none", background:"none", color:"#185FA5", cursor:"pointer", padding:0, fontSize:11.5, textDecoration:"underline" }}>buscar con “Add existing job”</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {dcalView === "week" ? (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:8 }}>
                {range.map(ds => {
                  const d = new Date(ds + "T00:00:00");
                  const evs = deliveryEvents[ds] || [];
                  const isToday = ds === today();
                  return (
                    <div key={ds} style={{ background:"#fff", border:`1px solid ${isToday?"#378ADD":"#efefef"}`, borderRadius:10, minHeight:160, display:"flex", flexDirection:"column" }}>
                      <div onClick={() => setDcalDayMenu(ds)} title="Add to this day" style={{ padding:"7px 9px", borderBottom:"1px solid #f3f3f3", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ fontSize:11, fontWeight:600 }}>{DOW_ES[d.getDay()]} {d.getDate()}</span>
                        <span style={{ color:"#bbb", fontSize:13 }}>+</span>
                      </div>
                      <div style={{ padding:7, flex:1 }}>{evs.map(g => <Event key={g.key} g={g} />)}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ background:"#fff", border:"1px solid #efefef", borderRadius:10, overflow:"hidden" }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)" }}>
                  {DOW_ES.map(d => <div key={d} style={{ padding:"8px 6px", textAlign:"center", fontSize:10, fontWeight:700, color:"#aaa", textTransform:"uppercase", borderBottom:"1px solid #efefef" }}>{d}</div>)}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)" }}>
                  {grid.map(({ date, inMonth }) => {
                    const d = new Date(date + "T00:00:00");
                    const evs = deliveryEvents[date] || [];
                    const isToday = date === today();
                    return (
                      <div key={date} style={{ borderRight:"1px solid #f4f4f4", borderBottom:"1px solid #f4f4f4", minHeight:96, padding:5, background: inMonth?"#fff":"#fafafa", opacity: inMonth?1:0.6 }}>
                        <div onClick={() => setDcalDayMenu(date)} title="Add to this day" style={{ cursor:"pointer", fontSize:10.5, fontWeight:600, color: isToday?"#185FA5":"#666", marginBottom:3 }}>{d.getDate()}</div>
                        {evs.slice(0,3).map(g => <Event key={g.key} g={g} />)}
                        {evs.length > 3 && <div style={{ fontSize:9, color:"#999" }}>+{evs.length-3} more</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Delivery calendar: "what do you want to add to this day?" menu */}
      {dcalDayMenu && (
        <Modal title={`Add to ${dcalDayMenu}`} onClose={() => setDcalDayMenu(null)}
          footer={<><Btn onClick={() => setDcalDayMenu(null)}>Cancel</Btn></>}>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            <Btn primary onClick={() => { const d = dcalDayMenu; setDcalDayMenu(null); openAddJobDeliveryDate(d); }} style={{ justifyContent:"center", padding:"12px" }}>🆕 Create new job on this day</Btn>
            <Btn onClick={() => openDcalAddExisting(dcalDayMenu)} style={{ justifyContent:"center", padding:"12px" }}>📋 Add an existing job to this day</Btn>
          </div>
        </Modal>
      )}

      {/* Delivery calendar: search existing jobs (no delivery date yet) and put them on a date */}
      {dcalAddExisting && (() => {
        const q = dcalAddSearch.trim().toLowerCase();
        const seen = new Set(); const results = [];
        for (const j of jobs) {
          if (j.delivery_date) continue;                            // only jobs not on the delivery calendar yet
          if (j.date_out || j.status === "cancelled") continue;     // skip closed/cancelled jobs
          const k = jobKey(j); if (seen.has(k)) continue; seen.add(k);
          const names = jobDriverNames(j);
          const hay = [j.job_number, j.customer, j.driver, names].filter(Boolean).join(" ").toLowerCase();
          if (q && !hay.includes(q)) continue;
          results.push({ key:k, job_number:j.job_number, customer:j.customer, status:j.status, drivers:names });
        }
        const shown = results.slice(0, 60);
        return (
          <Modal title="Add existing job to delivery calendar" onClose={() => setDcalAddExisting(null)}
            footer={<><Btn onClick={() => setDcalAddExisting(null)}>Close</Btn></>}>
            <div style={{ display:"flex", gap:10, alignItems:"flex-end", flexWrap:"wrap", marginBottom:10 }}>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Delivery date</label>
                <input style={inp} type="date" value={dcalAddDate} onChange={e => setDcalAddDate(e.target.value)} />
              </div>
              <div style={{ flex:1, minWidth:180, display:"flex", flexDirection:"column", gap:3 }}>
                <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Search</label>
                <input style={inp} value={dcalAddSearch} onChange={e => setDcalAddSearch(e.target.value)} placeholder="Search job # / client / driver…" autoFocus />
              </div>
            </div>
            <div style={{ fontSize:11.5, color:"#999", marginBottom:8 }}>Only jobs without a delivery date are listed. Pick a date above, then click a job to put it on the calendar.</div>
            <div style={{ border:"1px solid #eee", borderRadius:9, maxHeight:340, overflowY:"auto", background:"#fff" }}>
              {shown.length === 0 ? (
                <div style={{ padding:"16px", fontSize:12.5, color:"#bbb", textAlign:"center" }}>{q ? "No matching jobs without a delivery date." : "No jobs pending a delivery date."}</div>
              ) : shown.map(g => (
                <div key={g.key} onClick={() => addExistingJobToDeliveryCalendar(g, dcalAddDate)}
                  style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", borderBottom:"1px solid #f6f6f6", cursor:"pointer", fontSize:12.5 }}
                  onMouseEnter={e => e.currentTarget.style.background = "#f7faf1"} onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div><b style={{ fontFamily:"monospace" }}>{g.job_number || "(no #)"}</b> · {g.customer || "—"}</div>
                    <div style={{ color:"#999", marginTop:2, display:"flex", gap:8, flexWrap:"wrap" }}>
                      <StatusBadge status={g.status} />{g.drivers && <span>🧑‍✈️ {g.drivers}</span>}
                    </div>
                  </div>
                  <Btn primary style={{ padding:"5px 11px", fontSize:12 }} onClick={(e) => { e.stopPropagation(); addExistingJobToDeliveryCalendar(g, dcalAddDate); }}>Add</Btn>
                </div>
              ))}
            </div>
          </Modal>
        );
      })()}

      {/* ───────────────────────── BROKERS ───────────────────────── */}
      {page === "brokers" && (
        <>
          <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
            <Btn primary disabled={crmV2Missing} onClick={openAddBroker}>+ New broker</Btn>
          </div>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["Broker","Contact","Phone","Jobs","Balance pend.","Broker share","CS abiertos","Owes us","We owe","Net","" ].map((h, i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {brokers.length === 0 ? (
                    <tr><td colSpan={11} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{crmV2Missing ? "Run the setup SQL to enable brokers." : "No brokers added."}</td></tr>
                  ) : brokers.map(b => {
                    const st = brokerStats[b.id] || { jobs:new Set(), balance:0 };
                    const count = st.jobs.size;
                    const ss = brokerSettleStats[b.id] || { open:0, owesUs:0, weOwe:0 };
                    const net = ss.owesUs - ss.weOwe;
                    return (
                      <tr key={b.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", fontWeight:600 }}><button onClick={() => setBrokerDetailId(b.id)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#111", fontWeight:600, textDecoration:"underline" }}>{b.name}</button></td>
                        <td style={{ padding:"12px" }}>{b.contact_name||"—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{b.contact_phone ? <a href={`tel:${b.contact_phone}`} style={{ color:"#185FA5", textDecoration:"none" }}>{b.contact_phone}</a> : "—"}</td>
                        <td style={{ padding:"12px" }}><span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: count>0?"#EAF3DE":"#f5f5f5", color: count>0?"#3B6D11":"#bbb" }}>{count}</span></td>
                        <td style={{ padding:"12px", fontWeight:600, color: st.balance>0 ? "#1A8A4E" : "#bbb", whiteSpace:"nowrap" }}>${st.balance.toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", color: (brokerShareByBroker[b.id]||0)>0 ? "#C2410C" : "#bbb", fontWeight:600 }}>${Math.round(brokerShareByBroker[b.id]||0).toLocaleString()}</td>
                        <td style={{ padding:"12px" }}>{ss.open || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", color: ss.owesUs>0?"#1A8A4E":"#bbb" }}>${Math.round(ss.owesUs).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", color: ss.weOwe>0?"#A32D2D":"#bbb" }}>${Math.round(ss.weOwe).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:700, color: net>=0?"#1A8A4E":"#A32D2D" }}>{net>=0?`+$${Math.round(net).toLocaleString()}`:`−$${Math.round(-net).toLocaleString()}`}</td>
                        <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                          <Btn onClick={() => openEditBroker(b)} style={{ padding:"4px 10px", fontSize:12 }}>Edit</Btn>
                          <Btn danger onClick={() => deleteBroker(b)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Delete</Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{brokers.length} broker(s)</div>
          </div>
        </>
      )}

      {/* ───────────────────────── DRIVERS ───────────────────────── */}
      {page === "drivers" && (
        <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Driver","Phone","Grupo WhatsApp","Jobs activos","Status",""].map((h,i) => (
                    <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {driversList.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{crmV3Missing ? "Run the setup SQL to enable drivers." : "No drivers. Add one with “+ Driver”."}</td></tr>
                ) : driversList.map(d => {
                  const act = new Set(jobs.filter(j => !j.date_out && j.status !== "cancelled" && ((Array.isArray(j.driver_ids) && j.driver_ids.includes(d.id)) || (j.driver && d.name && j.driver.includes(d.name)))).map(jobKey)).size;
                  return (
                    <tr key={d.id} style={{ borderBottom:"1px solid #fafafa" }}>
                      <td style={{ padding:"12px", fontWeight:600 }}>
                        <button onClick={() => setDriverDetailId(d.id)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#111", fontWeight:600, textDecoration:"underline" }}>{d.name}</button>
                      </td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{d.phone ? <a href={`tel:${d.phone}`} style={{ color:"#185FA5", textDecoration:"none" }}>{d.phone}</a> : "—"}</td>
                      <td style={{ padding:"12px" }}>{d.whatsapp_group_link ? <a href={d.whatsapp_group_link} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E", textDecoration:"none" }}>Open group ↗</a> : "—"}</td>
                      <td style={{ padding:"12px" }}><span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: act>0?"#EAF3DE":"#f5f5f5", color: act>0?"#3B6D11":"#bbb" }}>{act}</span></td>
                      <td style={{ padding:"12px" }}><span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background: d.active!==false?"#EAF3DE":"#f1f1f1", color: d.active!==false?"#3B6D11":"#888" }}>{d.active!==false?"Active":"Inactivo"}</span></td>
                      <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                        <Btn onClick={() => openEditDriver(d)} style={{ padding:"4px 10px", fontSize:12 }}>Edit</Btn>
                        <Btn danger onClick={() => deleteDriver(d)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Delete</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{driversList.length} driver(s)</div>
        </div>
      )}

      {/* ───────────────────────── CLIENTES ───────────────────────── */}
      {page === "clientes" && (
        <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Client","Phone","Email","Jobs activos","Total jobs","Outstanding balance"].map((h,i) => (
                    <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {clients.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>No clients yet.</td></tr>
                ) : clients.map(c => (
                  <tr key={c.name} style={{ borderBottom:"1px solid #fafafa" }}>
                    <td style={{ padding:"12px", fontWeight:600 }}>
                      <button onClick={() => setClientDetail(c.name)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#111", fontWeight:600, textDecoration:"underline" }}>{c.name}</button>
                    </td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{c.phone ? <a href={`tel:${c.phone}`} style={{ color:"#185FA5", textDecoration:"none" }}>{c.phone}</a> : "—"}</td>
                    <td style={{ padding:"12px" }}>{c.email ? <a href={`mailto:${c.email}`} style={{ color:"#185FA5", textDecoration:"none" }}>{c.email}</a> : "—"}</td>
                    <td style={{ padding:"12px" }}><span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: c.active.size>0?"#EAF3DE":"#f5f5f5", color: c.active.size>0?"#3B6D11":"#bbb" }}>{c.active.size}</span></td>
                    <td style={{ padding:"12px", color:"#888" }}>{c.jobs.size}</td>
                    <td style={{ padding:"12px", fontWeight:600, color: c.balance>0?"#1A8A4E":"#bbb", whiteSpace:"nowrap" }}>${c.balance.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{clients.length} cliente(s)</div>
        </div>
      )}

      {/* ───────────────────────── SETTLEMENTS (list) ───────────────────────── */}
      {page === "settlements" && !csDetailId && (
        <>
          {settlementsMissing && (
            <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <span>For Carrier Settlements (closing sheets + BOL collections + document upload), run the setup SQL once in Supabase.</span>
              <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:10, marginBottom:16 }}>
            {[
              { label:"Open closing sheets", value:settlementMetrics.openCount, color:"#185FA5" },
              { label:"Broker owes us", value:"$"+Math.round(settlementMetrics.owesUs).toLocaleString(), color:"#1A8A4E" },
              { label:"We owe brokers", value:"$"+Math.round(settlementMetrics.weOwe).toLocaleString(), color:"#A32D2D" },
              { label:"Outstanding BOL collections", value:"$"+Math.round(settlementMetrics.pendingBol).toLocaleString(), color:"#C2410C" },
              { label:"Pads outstanding ($)", value:"$"+Math.round(settlementMetrics.padsValue).toLocaleString(), color:"#92760B" },
            ].map(m => (
              <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{m.label}</div>
                <div style={{ fontSize:20, fontWeight:800, color:m.color, marginTop:3 }}>{m.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
            {[["open","Open"],["settled","Settled"],["disputed","Disputed"],["all","All"]].map(([t,l]) => (
              <button key={t} onClick={() => setCsTab(t)} style={{ fontSize:13, fontWeight: csTab===t?600:400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: csTab===t?"#111":"#999", borderBottom: csTab===t?"2px solid #111":"2px solid transparent" }}>{l}</button>
            ))}
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["CS #","Broker","Driver","Load date","Jobs","Total CF","Carrier fee","BOL collected","Net settlement","Status","Actions"].map((h,i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {closingSheets.filter(s => csTab==="all" || s.status===csTab).length === 0 ? (
                    <tr><td colSpan={11} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{settlementsMissing ? "Run the SQL to enable settlements." : "No closing sheets. Create one with “+ Closing sheet”."}</td></tr>
                  ) : closingSheets.filter(s => csTab==="all" || s.status===csTab).map(s => {
                    const c = sheetCalcById[s.id] || {};
                    const ageDays = s.created_at ? Math.round((startOfToday() - new Date(s.created_at)) / ONE_DAY) : 0;
                    const stale = s.status === "open" && ageDays >= 30;
                    return (
                      <tr key={s.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <button onClick={() => setCsDetailId(s.id)} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{s.closing_sheet_number || `#${s.id}`}</button>
                          {stale && <span title={`Open for ${ageDays} days`} style={{ marginLeft:6, fontSize:10, fontWeight:700, color:"#92760B", background:"#FEF3C7", borderRadius:10, padding:"1px 6px" }}>⚠ {ageDays}d</span>}
                        </td>
                        <td style={{ padding:"12px" }}>{brokerName(s.broker_id) || "—"}</td>
                        <td style={{ padding:"12px" }}>{driverById[s.driver_id]?.name || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{s.load_date || "—"}</td>
                        <td style={{ padding:"12px" }}>{c.jobCount || 0}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{Math.round(c.totalCf || 0).toLocaleString()} CF</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>${Math.round(c.carrierFee || 0).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>${Math.round(c.bolCollected || 0).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:700, color: (c.net||0) >= 0 ? "#1A8A4E" : "#A32D2D" }}>{(c.net||0) >= 0 ? `+$${Math.round(c.net||0).toLocaleString()}` : `−$${Math.round(-(c.net||0)).toLocaleString()}`}</td>
                        <td style={{ padding:"12px" }}><CSBadge status={s.status} /></td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <Btn onClick={() => setCsDetailId(s.id)} style={{ padding:"4px 10px", fontSize:12 }}>Ver</Btn>
                          {s.status !== "settled" && <Btn onClick={() => setCsStatus(s, "settled")} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Settled</Btn>}
                          {s.status !== "disputed" && <Btn danger onClick={() => setCsStatus(s, "disputed")} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Dispute</Btn>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{closingSheets.filter(s => csTab==="all" || s.status===csTab).length} closing sheet(s)</div>
          </div>
        </>
      )}

      {/* ───────────────────────── SETTLEMENTS (detail) ───────────────────────── */}
      {page === "settlements" && csDetailId && (() => {
        const s = sheetById[csDetailId];
        if (!s) return <div style={{ color:"#bbb" }}>Closing sheet no encontrado. <button onClick={() => setCsDetailId(null)} style={{ color:"#185FA5", background:"none", border:"none", cursor:"pointer" }}>Back</button></div>;
        const jobsIn = jobsBySheet[csDetailId] || [];
        const c = sheetCalc(s, jobsIn);
        const brokerNm = brokerName(s.broker_id);
        const driverNm = driverById[s.driver_id]?.name || "";
        const isImg = s.document_url && /\.(jpe?g|png|gif|webp|heic)$/i.test(s.document_url);
        const m = (n) => `$${Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2})}`;
        const ageDays = s.created_at ? Math.round((startOfToday() - new Date(s.created_at)) / ONE_DAY) : 0;
        return (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
              <Btn onClick={() => setCsDetailId(null)}>← Back</Btn>
              <span style={{ flex:1 }} />
              <Btn onClick={() => exportCsPdf(s, c, brokerNm, driverNm, jobsIn)}>📄 Export PDF</Btn>
              <a href={settlementWaLink(s, c, brokerNm, driverNm)} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn>💬 WhatsApp broker</Btn></a>
              <Btn onClick={() => openEditCs(s)}>Edit</Btn>
              {s.status !== "settled" && <Btn primary onClick={() => setCsStatus(s, "settled")}>Mark settled</Btn>}
            </div>

            {s.status === "open" && ageDays >= 30 && (
              <div style={{ background:"#FEF3C7", border:"1px solid #EAB308", borderRadius:10, padding:"9px 13px", marginBottom:14, fontSize:13, color:"#92760B" }}>⚠️ This closing sheet has been open for {ageDays} days.</div>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 280px", gap:14, marginBottom:14 }}>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ fontSize:20, fontWeight:800, fontFamily:"monospace" }}>#{s.closing_sheet_number || s.id}</span>
                  <CSBadge status={s.status} />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:12 }}>
                  <DetailRow label="Broker" value={brokerNm} />
                  <DetailRow label="Driver" value={driverNm} />
                  <DetailRow label="Load date" value={s.load_date} />
                  <DetailRow label="Jobs · CF" value={`${c.jobCount} · ${Math.round(c.totalCf)} CF`} />
                </div>
                <div style={{ marginTop:12 }}>
                  <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:5 }}>Notas</div>
                  <textarea defaultValue={s.notes || ""} onBlur={e => { if ((e.target.value||"") !== (s.notes||"")) supabase.from("closing_sheets").update({ notes: e.target.value || null }).eq("id", s.id).then(loadClosingSheets); }}
                    placeholder="Closing sheet notes..." style={{ ...inp, minHeight:60, resize:"vertical", fontFamily:"inherit" }} />
                </div>
              </div>

              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:8 }}>Documento original</div>
                <label style={{ display:"block", border:"2px dashed #ddd", borderRadius:10, padding:"14px", textAlign:"center", cursor:"pointer", background:"#fafafa" }}
                  onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) uploadCsDoc(f, s); }}>
                  <input type="file" accept="image/*,application/pdf" style={{ display:"none" }} onChange={e => uploadCsDoc(e.target.files?.[0], s)} />
                  {docUploading ? <div style={{ fontSize:12, color:"#888" }}>Subiendo…</div>
                    : s.document_url ? (
                      isImg ? <img src={s.document_url} alt="doc" style={{ maxWidth:"100%", maxHeight:160, borderRadius:6 }} />
                        : <div style={{ fontSize:13 }}>📄 <a href={s.document_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color:"#185FA5" }}>Ver documento (PDF)</a></div>
                    ) : <div style={{ fontSize:12, color:"#999" }}>Drag or click to upload closing-sheet photo/PDF</div>}
                </label>
                {s.document_url && <div style={{ fontSize:11, color:"#aaa", marginTop:6, textAlign:"center" }}>Click the area to replace</div>}
              </div>
            </div>

            {/* Jobs table */}
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden", marginBottom:14 }}>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead>
                    <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                      {["Job #","Client","From → To","CF","Pads","Rate/CF","Carrier fee","BOL balance","Collected","Method","Collection","Actions"].map((h,i) => (
                        <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {jobsIn.length === 0 ? (
                      <tr><td colSpan={12} style={{ padding:"40px", textAlign:"center", color:"#bbb" }}>No jobs assigned. Use “Edit” to add jobs.</td></tr>
                    ) : jobsIn.map(j => {
                      const k = jobKey(j);
                      const cs = collectionStatus(j);
                      const fee = parseCf(j.volume) * numv(j.carrier_rate_per_cf);
                      const route = [[j.pickup_city, j.pickup_state].filter(Boolean).join(" "), [j.delivery_city, j.delivery_state].filter(Boolean).join(" ")].filter(Boolean).join(" → ");
                      return (
                        <tr key={j.id} style={{ borderBottom:"1px solid #fafafa" }}>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}><button onClick={() => setJobDetailKey(k)} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button></td>
                          <td style={{ padding:"10px 12px" }}>{j.customer || "—"}</td>
                          <td style={{ padding:"10px 12px", fontSize:12, color:"#555" }}>{route || "—"}</td>
                          <td style={{ padding:"10px 12px" }}><input defaultValue={parseCf(j.volume) || ""} onBlur={e => { if (e.target.value !== String(parseCf(j.volume))) updateJobBol(k, "volume", e.target.value); }} style={{ ...inp, width:64, padding:"5px 7px" }} /></td>
                          <td style={{ padding:"10px 12px", fontSize:12, whiteSpace:"nowrap" }}>{numv(j.pads_received)} rec{jobPadsMissing(j) > 0 && <span style={{ color:"#A32D2D", fontWeight:700 }}> · {jobPadsMissing(j)} falt</span>}</td>
                          <td style={{ padding:"10px 12px" }}><input defaultValue={j.carrier_rate_per_cf ?? ""} onBlur={e => { if ((e.target.value||"") !== String(j.carrier_rate_per_cf ?? "")) updateJobBol(k, "carrier_rate_per_cf", e.target.value === "" ? "" : Number(e.target.value)); }} placeholder="0" style={{ ...inp, width:64, padding:"5px 7px" }} /></td>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap", fontWeight:600 }}>${Math.round(fee).toLocaleString()}</td>
                          <td style={{ padding:"10px 12px" }}><input defaultValue={j.bol_balance ?? ""} onBlur={e => { if ((e.target.value||"") !== String(j.bol_balance ?? "")) updateJobBol(k, "bol_balance", e.target.value === "" ? "" : Number(e.target.value)); }} placeholder="0" style={{ ...inp, width:72, padding:"5px 7px" }} /></td>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap", fontWeight:600, color:"#1A8A4E" }}>{money(j.bol_collected) || "$0"}</td>
                          <td style={{ padding:"10px 12px", fontSize:12 }}>{j.bol_payment_method ? (PAY_METHODS.find(p=>p.v===j.bol_payment_method)?.l || j.bol_payment_method) : "—"}</td>
                          <td style={{ padding:"10px 12px" }}><span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background:cs.bg, color:cs.text }}><span style={{ width:6, height:6, borderRadius:"50%", background:cs.dot }} />{cs.l}</span></td>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}><Btn onClick={() => setPayModal({ jobKey:k, amount: j.bol_collected ?? "", method: j.bol_payment_method || "", date: j.bol_collected_date || today(), notes:"", entries:[{ method:"cash", amount:"" }] })} style={{ padding:"4px 9px", fontSize:11 }}>Record payment</Btn></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pads + Deductions + Settlement */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Pads (por job)</div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead><tr style={{ color:"#aaa", fontSize:10, textTransform:"uppercase" }}>
                    <th style={{ textAlign:"left", padding:"3px 4px" }}>Job</th><th style={{ textAlign:"right", padding:"3px 4px" }}>Recib.</th><th style={{ textAlign:"right", padding:"3px 4px" }}>Devuel.</th><th style={{ textAlign:"right", padding:"3px 4px" }}>Falt.</th>
                  </tr></thead>
                  <tbody>
                    {jobsIn.map(j => { const miss = jobPadsMissing(j); return (
                      <tr key={j.id} style={{ borderTop:"1px solid #f4f4f4" }}>
                        <td style={{ padding:"3px 4px", fontFamily:"monospace" }}>{j.job_number || "-"}</td>
                        <td style={{ padding:"3px 4px", textAlign:"right" }}>{numv(j.pads_received)}</td>
                        <td style={{ padding:"3px 4px", textAlign:"right" }}>{numv(j.pads_returned)}</td>
                        <td style={{ padding:"3px 4px", textAlign:"right", color: miss>0?"#C2410C":"#111", fontWeight: miss>0?700:400 }}>{miss}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
                <div style={{ borderTop:"1px solid #eee", marginTop:8, paddingTop:8 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Total enviados</span><b>{c.padsSent}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Total devueltos</span><b>{c.padsReturned}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Total faltantes</span><b style={{ color: c.padsMissing>0?"#C2410C":"#111" }}>{c.padsMissing}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Cargo por pad</span><b>{m(s.charge_per_pad != null ? s.charge_per_pad : 7)}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"6px 0 0", borderTop:"1px solid #f0f0f0", paddingTop:6 }}><span>Total pads charge</span><b>{m(c.padsCharge)}</b></div>
                </div>
              </div>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Deducciones del broker</div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Trip cost</span><b>{m(s.trip_cost)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Labor</span><b>{m(s.labor_charges)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Other fees{s.other_fees_description ? ` (${s.other_fees_description})` : ""}</span><b>{m(s.other_fees)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"6px 0 0", borderTop:"1px solid #f0f0f0", paddingTop:6 }}><span>Total deducciones</span><b>{m(c.deductions)}</b></div>
              </div>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Broker nos debe</div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Carrier fee subtotal</span><b>{m(c.carrierFee)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Trip cost</span><span>{m(s.trip_cost)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Labor</span><span>{m(s.labor_charges)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Other fees</span><span>{m(s.other_fees)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Pads charge</span><span>{m(c.padsCharge)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:15, margin:"8px 0 0", borderTop:"1px solid #eee", paddingTop:8, fontWeight:800 }}><span>Total broker nos debe</span><span>{m(c.netCarrier)}</span></div>
              </div>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Cobrado a clientes (BOL)</div>
                {jobsIn.map(j => (
                  <div key={j.id} style={{ display:"flex", justifyContent:"space-between", fontSize:12, margin:"4px 0", color:"#555" }}><span style={{ fontFamily:"monospace" }}>{j.job_number || "-"}</span><span>{money(j.bol_collected) || "$0"} / {money(j.bol_balance) || "$0"}</span></div>
                ))}
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:15, margin:"8px 0 0", borderTop:"1px solid #eee", paddingTop:8, fontWeight:800 }}><span>Total cobrado</span><span>{m(c.bolCollected)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginTop:4, color:"#C2410C" }}><span>Pending</span><span>{m(c.pending)}</span></div>
              </div>
            </div>

            <div style={{ background: c.net >= 0 ? "#EAF3DE" : "#FCEBEB", border:`1px solid ${c.net >= 0 ? "#639922" : "#E24B4A"}`, borderRadius:12, padding:"18px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
              <div>
                <div style={{ fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em", color: c.net >= 0 ? "#3B6D11" : "#A32D2D" }}>Net result</div>
                <div style={{ fontSize:22, fontWeight:800, color: c.net >= 0 ? "#3B6D11" : "#A32D2D", marginTop:3 }}>{c.net >= 0 ? `Broker owes you ${m(c.net)}` : `You owe the broker ${m(-c.net)}`}</div>
              </div>
              {s.status !== "settled" && <Btn primary onClick={() => setCsStatus(s, "settled")}>Mark as settled</Btn>}
            </div>
          </>
        );
      })()}

      {/* ───────────────────────── TRUCKS ───────────────────────── */}
      {page === "trucks" && (
        <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Truck","Patente / VIN","Capacidad CF","Current load","Occupancy","Status",""].map((h,i) => (
                    <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trucksList.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{tripsMissing ? "Run the setup SQL to enable trucks." : "No trucks. Add one with “+ Truck”."}</td></tr>
                ) : trucksList.map(tk => {
                  const activeTrip = trips.find(tp => tp.truck_id === tk.id && TRIP_ACTIVE(tp.status));
                  const load = activeTrip ? tripCalc(activeTrip).loadedCf : 0;
                  const cap = numv(tk.capacity_cf);
                  const pct = cap > 0 ? Math.min(100, Math.round((load / cap) * 100)) : null;
                  return (
                    <tr key={tk.id} style={{ borderBottom:"1px solid #fafafa" }}>
                      <td style={{ padding:"12px" }}>
                        <button onClick={() => setTruckDetailId(tk.id)} style={{ fontWeight:600, fontSize:13, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline", textAlign:"left" }}>{tk.name}</button>
                        {truckSubtitle(tk) && <div style={{ fontSize:11, color:"#888", marginTop:2 }}>{truckSubtitle(tk)}</div>}
                      </td>
                      <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12 }}>
                        {[tk.license_plate, tk.license_state].filter(Boolean).join(" ") || tk.plate || "—"}
                        {tk.vin && <div style={{ fontSize:10, color:"#aaa", marginTop:2 }}>{tk.vin}</div>}
                      </td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{cap > 0 ? `${cap.toLocaleString()} CF` : "—"}</td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{activeTrip ? `${Math.round(load).toLocaleString()} CF` : "—"}</td>
                      <td style={{ padding:"12px", minWidth:120 }}>{cap > 0 && activeTrip ? <OccupancyBar used={load} total={cap} /> : <span style={{ color:"#bbb" }}>—</span>}</td>
                      <td style={{ padding:"12px" }}><span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background: tk.active!==false?"#EAF3DE":"#f1f1f1", color: tk.active!==false?"#3B6D11":"#888" }}>{tk.active!==false?"Active":"Inactivo"}</span></td>
                      <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                        <Btn onClick={() => openEditTruck(tk)} style={{ padding:"4px 10px", fontSize:12 }}>Edit</Btn>
                        <Btn danger onClick={() => deleteTruck(tk)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Delete</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{trucksList.length} truck(s)</div>
        </div>
      )}

      {/* ───────────────────────── EQUIPMENT / MATERIALS ───────────────────────── */}
      {page === "equipment" && (() => {
        const locLabel = (i) => i.warehouse ? `🏭 ${i.warehouse}` : (i.storage_id ? ([storageById[i.storage_id]?.brand, storageById[i.storage_id]?.unit && "U" + storageById[i.storage_id]?.unit].filter(Boolean).join(" ") || `Unit #${i.storage_id}`) : "—");
        const q = equipmentSearch.trim().toLowerCase();
        const shownItems = q ? equipmentItems.filter(i => [i.name, i.category, i.notes, i.warehouse].join(" ").toLowerCase().includes(q)) : equipmentItems;
        const inTransit = equipmentItems.filter(i => i.status === "in_transit").length;
        const activeTrips = trips.filter(t => TRIP_ACTIVE(t.status));
        return (
          <>
            {equipmentMissing && (
              <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span>{trAI("For the Equipment tab, run the setup SQL once in Supabase.", "Para la pestaña de Equipment, corré el SQL de setup una vez en Supabase.")}</span>
                <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:16 }}>
              {[
                { label:trAI("Items", "Items"), value:equipmentItems.length, color:"#111" },
                { label:trAI("Available", "Disponibles"), value:equipmentItems.length - inTransit, color:"#1A8A4E" },
                { label:trAI("In transit", "En tránsito"), value:inTransit, color:"#7C3AED" },
              ].map(mt => (
                <div key={mt.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                  <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{mt.label}</div>
                  <div style={{ fontSize:20, fontWeight:800, color:mt.color, marginTop:3 }}>{mt.value}</div>
                </div>
              ))}
            </div>
            <input style={{ ...inp, maxWidth:340, marginBottom:12 }} value={equipmentSearch} onChange={e => setEquipmentSearch(e.target.value)} placeholder={trAI("Search by name / category / location…", "Buscar por nombre / categoría / location…")} />
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead>
                    <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                      {[trAI("Item", "Item"), trAI("Category", "Categoría"), trAI("Qty", "Cant."), trAI("Location", "Location"), "Status", ""].map((h,i) => (
                        <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shownItems.length === 0 ? (
                      <tr><td colSpan={6} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{equipmentMissing ? trAI("Run the setup SQL to enable equipment.", "Corré el SQL de setup para habilitar equipment.") : trAI("No equipment items. Add one with “+ Item”.", "Sin items de equipo. Agregá uno con “+ Item”.")}</td></tr>
                    ) : shownItems.map(item => {
                      const cat = equipmentCat(item.category);
                      const onTrip = item.trip_id ? tripById[item.trip_id] : null;
                      return (
                        <tr key={item.id} style={{ borderBottom:"1px solid #fafafa" }}>
                          <td style={{ padding:"12px" }}>
                            <div style={{ fontWeight:600 }}>{item.name || "—"}</div>
                            {item.notes && <div style={{ fontSize:11, color:"#888", marginTop:2 }}>{item.notes}</div>}
                          </td>
                          <td style={{ padding:"12px", whiteSpace:"nowrap" }}><span style={{ fontSize:11, fontWeight:700, color:cat.color, background:cat.color+"18", borderRadius:20, padding:"2px 9px" }}>{cat.icon} {trAI(cat.label, cat.es)}</span></td>
                          <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{numv(item.quantity) || 1}</td>
                          <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{item.status === "in_transit" && onTrip ? `🚚 ${onTrip.trip_number || "#" + onTrip.id}` : locLabel(item)}</td>
                          <td style={{ padding:"12px" }}><span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background: item.status === "in_transit" ? "#EDE9FE" : "#EAF3DE", color: item.status === "in_transit" ? "#6D28D9" : "#3B6D11", whiteSpace:"nowrap" }}>{item.status === "in_transit" ? trAI("In transit", "En tránsito") : trAI("Available", "Disponible")}</span></td>
                          <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                            {item.status === "in_transit"
                              ? <Btn onClick={() => setEquipUnloadItem(item)} style={{ padding:"4px 10px", fontSize:12 }}>📤 {trAI("Unload", "Descargar")}</Btn>
                              : <Btn disabled={!activeTrips.length} title={!activeTrips.length ? trAI("No active trips", "No hay trips activos") : ""} onClick={() => setEquipLoadItem(item)} style={{ padding:"4px 10px", fontSize:12 }}>🚚 {trAI("Load on trip", "Cargar a trip")}</Btn>}
                            <Btn onClick={() => { setEditingEquipmentId(item.id); setEquipmentForm({ name:item.name || "", category:item.category || "other", quantity:String(numv(item.quantity) || 1), location: item.storage_id ? `u:${item.storage_id}` : (item.warehouse ? `w:${item.warehouse}` : ""), notes:item.notes || "" }); setShowEquipmentModal(true); }} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Edit</Btn>
                            <Btn danger onClick={() => deleteEquipmentItem(item)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Delete</Btn>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{shownItems.length} item(s)</div>
            </div>
          </>
        );
      })()}

      {/* ───────────────────────── TRIPS / LIVE LOAD ───────────────────────── */}
      {page === "trips" && (() => {
        // One row in a trip's unified stop sequence — a job or a custom stop.
        // Drag-reorder operates on the whole sequence (jobs + custom interleaved).
        const onSeqDrop = (trip, seq, idx) => (e) => {
          e.preventDefault();
          const from = parseInt(e.dataTransfer.getData("text/plain"));
          if (isNaN(from) || from === idx) return;
          const arr = [...seq]; const [mv] = arr.splice(from, 1); arr.splice(idx, 0, mv);
          persistUnifiedOrder(trip, arr);
        };
        const SeqRow = ({ trip, item, idx, seq }) => {
          const dragProps = {
            draggable: true,
            onDragStart: e => e.dataTransfer.setData("text/plain", String(idx)),
            onDragOver: e => e.preventDefault(),
            onDrop: onSeqDrop(trip, seq, idx),
          };
          // Drop target props for a row whose drag is initiated only by its handle
          // (so clicks on the row body aren't swallowed by the drag machinery).
          const dropProps = { onDragOver: e => e.preventDefault(), onDrop: onSeqDrop(trip, seq, idx) };
          const numBadge = (bg) => <span style={{ width:20, height:20, borderRadius:"50%", background:bg, color:"#fff", fontSize:10, fontWeight:700, display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{idx + 1}</span>;
          const handle = <span title={trAI("Drag to reorder", "Arrastrá para reordenar")} style={{ color:"#ccc", cursor:"grab" }}>⠿</span>;
          const dragHandle = <span draggable onDragStart={e => e.dataTransfer.setData("text/plain", String(idx))} title={trAI("Drag to reorder", "Arrastrá para reordenar")} style={{ color:"#ccc", cursor:"grab", flexShrink:0 }}>⠿</span>;
          if (item.kind === "custom") {
            const s = item.s, cat = tripStopCat(s.category);
            return (
              <div {...dropProps} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 6px", borderBottom:"1px solid #f4f4f4", fontSize:12, background: s.done ? "#fafafa" : "#fbfbfd", opacity: s.done ? 0.7 : 1 }}>
                {dragHandle}
                {numBadge(cat.color)}
                <div onClick={() => openEditStop(trip, s)} title={trAI("Edit address / note", "Editar dirección / nota")} style={{ flex:1, minWidth:0, cursor:"pointer" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10.5, fontWeight:700, color:cat.color, background:cat.color+"18", borderRadius:20, padding:"1px 8px", whiteSpace:"nowrap" }}>{cat.icon} {catLabel(s.category)}</span>
                    {s.done && <span style={{ fontSize:10, fontWeight:600, color:"#3B6D11" }}>{trAI("Done", "Hecho")}</span>}
                  </div>
                  {s.address
                    ? <div style={{ color:"#555", marginTop:3 }}>📍 {s.address}</div>
                    : <div style={{ color:"#bbb", marginTop:3, fontStyle:"italic" }}>{trAI("Add address / note…", "Agregar dirección / nota…")}</div>}
                  {s.note && <div style={{ color:"#888", marginTop:2, whiteSpace:"pre-wrap" }}>{s.note}</div>}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                  <button title={trAI("Edit address / note", "Editar dirección / nota")} onClick={() => openEditStop(trip, s)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, lineHeight:1 }}>✏️</button>
                  <span title={trAI("Mark done", "Marcar hecho")} onClick={() => toggleCustomStop(s)} style={{ cursor:"pointer", fontSize:15 }}>{s.done ? "✅" : "⬜"}</span>
                  <button title={trAI("Delete stop", "Eliminar parada")} onClick={() => deleteCustomStop(s)} style={{ background:"none", border:"none", color:"#c0392b", cursor:"pointer", fontSize:14, lineHeight:1 }}>✕</button>
                </div>
              </div>
            );
          }
          const j = item.j;
          const reloc = isRelocation(j);
          const delivered = !!j.date_out || j.status === "delivered";
          // Dropped at storage during the trip: still on the trip, but sitting in storage.
          // A relocation stop only counts as dropped once its storage_drop event exists —
          // in_storage without it means it's still waiting at the origin location.
          const relocDropped = reloc && (tripEventsByTrip[trip.id] || []).some(e => e.event_type === "storage_drop" && e.job_id && jobRowIdsForUnit(tripUnitKey(j)).includes(e.job_id));
          const dropped = !delivered && j.status === "in_storage" && (!reloc || relocDropped);
          const relocAtOrigin = reloc && !delivered && j.status === "in_storage" && !relocDropped;
          const dropLoc = j.warehouse ? `Warehouse ${j.warehouse}` : (storageById[j.storage_id]?.brand || "storage");
          const fromTo = [j.pickup_state, j.delivery_state].filter(Boolean).join(" → ");
          return (
            <div {...dragProps}
              style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 6px", borderBottom:"1px solid #f4f4f4", fontSize:12, background: (delivered || dropped) ? "#fafafa" : "#fff", cursor:"grab", opacity: (delivered || dropped) ? 0.7 : 1 }}>
              {handle}
              {numBadge("#111")}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                  <button onClick={() => setJobDetailKey(jobKey(j))} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                  {j.split_group && <span style={{ color:"#7C3AED", fontWeight:700, fontSize:10.5 }} title="Split load — one portion of this job">✂️ {splitLabel(j)}</span>}
                  {reloc && <span title={trAI("Internal move between locations — no delivery, no collection", "Movimiento interno entre locations — sin delivery, sin cobro")} style={{ color:"#185FA5", background:"#E6F1FB", fontWeight:700, fontSize:10, borderRadius:20, padding:"1px 7px", whiteSpace:"nowrap" }}>🔁 Relocation</span>}
                  <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.customer || "—"}</span>
                  {fromTo && <span style={{ color:"#888" }}>· {fromTo}</span>}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:3, flexWrap:"wrap", color:"#666" }}>
                  <span>{Math.round(effCf(j))} CF{hasRealCf(j) ? " ✓" : ""}</span>
                  {j.sticker_color && <span style={{ width:9, height:9, borderRadius:"50%", background: colorHex(j.sticker_color) || "#ccc", border:"1px solid #ccc" }} title={j.sticker_color} />}
                  {j.lot_number && <span style={{ fontFamily:"monospace" }}>{j.lot_number}</span>}
                  <FaddBadge fadd={j.fadd} />
                  {!reloc && jobToCollect(j) > 0 && <span style={{ color:"#1A8A4E", fontWeight:600 }}>${Math.round(jobToCollect(j)).toLocaleString()}</span>}
                </div>
              </div>
              {delivered
                ? <span style={{ fontSize:10, fontWeight:700, color:"#3B6D11", background:"#EAF3DE", borderRadius:20, padding:"2px 8px" }}>Delivered</span>
                : dropped
                ? <span title={dropLoc} style={{ fontSize:10, fontWeight:700, color: reloc ? "#3B6D11" : "#185FA5", background: reloc ? "#EAF3DE" : "#E7EFF8", borderRadius:20, padding:"2px 8px", whiteSpace:"nowrap" }}>{reloc ? "✅ Relocated" : "📦 Dropped in storage"}</span>
                : <div style={{ display:"flex", flexDirection:"column", gap:4, flexShrink:0 }}>
                    {!reloc && <Btn onClick={() => tripMarkDelivered(j)} style={{ padding:"3px 8px", fontSize:11, justifyContent:"center" }}>Mark delivered</Btn>}
                    {relocAtOrigin
                      ? <Btn onClick={() => tripRelocLoad(trip, j)} style={{ padding:"3px 8px", fontSize:11, justifyContent:"center" }}>🔼 {trAI("Load onto truck", "Cargar al camión")}</Btn>
                      : <Btn onClick={() => { setDropSel(""); setDropModal({ trip, jobKey: tripUnitKey(j), label: `${j.job_number || ""} ${j.customer || ""}`.trim() }); }} style={{ padding:"3px 8px", fontSize:11, justifyContent:"center" }}>📦 {reloc ? trAI("Drop at destination", "Dejar en destino") : "Dropped at storage"}</Btn>}
                    {!jobSplitColMissing && !reloc && <Btn onClick={() => { setSplitJobRow(j); setSplitCf(String(Math.round(effCf(j) / 2))); setSplitDest(""); }} title="Dividir este job en dos camiones" style={{ padding:"3px 8px", fontSize:11, justifyContent:"center" }}>✂️ Split</Btn>}
                  </div>}
            </div>
          );
        };
        const activeTrips = trips.filter(t => TRIP_ACTIVE(t.status));
        const unassignedTrips = trips.filter(t => !t.truck_id || !t.driver_id);
        const shown = tripsView === "active" ? activeTrips : tripsView === "unassigned" ? unassignedTrips : trips;
        return (
          <>
            {tripsMissing && (
              <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span>For Trips / Live Load (trucks, trips and live load), run the setup SQL once in Supabase.</span>
                <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:16 }}>
              {[
                { label:"Trips activos", value:tripMetrics.activeCount, color:"#7C3AED" },
                { label:"CF in transit", value:Math.round(tripMetrics.cfTransit).toLocaleString()+" CF", color:"#185FA5" },
                { label:"To collect in transit", value:"$"+Math.round(tripMetrics.collectTransit).toLocaleString(), color:"#1A8A4E" },
                { label:"Delivered today", value:tripMetrics.deliveredToday, color:"#3B6D11" },
              ].map(mt => (
                <div key={mt.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                  <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{mt.label}</div>
                  <div style={{ fontSize:20, fontWeight:800, color:mt.color, marginTop:3 }}>{mt.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14 }}>
              {[["live","🗺️ Live map"],["active","Active trips"],["unassigned","Unassigned trips"],["all","All trips"]].map(([v,l]) => (
                <button key={v} onClick={() => setTripsView(v)} style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: tripsView===v?"#fff":"none", color: tripsView===v?"#111":"#888", fontWeight: tripsView===v?600:400, boxShadow: tripsView===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
              ))}
            </div>

            {tripsView === "live" ? (() => {
              // Driver currently on each truck (from its active trip), for the side list.
              const driverByTruck = {};
              for (const tp of trips) { if (TRIP_ACTIVE(tp.status) && tp.truck_id) driverByTruck[tp.truck_id] = driverById[tp.driver_id]?.name; }
              const located = trucksList.filter(t => t.last_lat != null && t.last_lng != null);
              const visible = located.filter(t => liveStatusFilter === "all" ? true : (t.last_status || "unknown") === liveStatusFilter);
              const noLoc = trucksList.filter(t => t.last_lat == null || t.last_lng == null);
              const moving = located.filter(t => t.last_status === "moving").length;
              const stopped = located.filter(t => t.last_status === "stopped").length;
              return (
                <>
                  {truckLocMissing && (
                    <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:14, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                      <span>To save truck locations, run the updated setup SQL once in Supabase.</span>
                      <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
                    </div>
                  )}
                  <div style={{ display:"grid", gridTemplateColumns:"minmax(280px, 360px) 1fr", gap:14, alignItems:"start" }}>
                    {/* Verizon-style side list */}
                    <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden", maxHeight:560, display:"flex", flexDirection:"column" }}>
                      <div style={{ padding:"12px 14px", borderBottom:"1px solid #f0f0f0", display:"flex", gap:6, flexWrap:"wrap" }}>
                        {[["all",`All (${located.length})`],["moving",`En movimiento (${moving})`],["stopped",`Detenidos (${stopped})`]].map(([v,l]) => (
                          <button key={v} onClick={() => setLiveStatusFilter(v)} style={{ fontSize:11.5, padding:"4px 10px", borderRadius:20, cursor:"pointer", border:"1px solid", borderColor: liveStatusFilter===v?"#111":"#e5e5e5", background: liveStatusFilter===v?"#111":"#fff", color: liveStatusFilter===v?"#fff":"#666", fontWeight: liveStatusFilter===v?600:500 }}>{l}</button>
                        ))}
                      </div>
                      <div style={{ overflowY:"auto" }}>
                        {trucksList.length === 0 ? (
                          <div style={{ padding:"28px 16px", textAlign:"center", color:"#bbb", fontSize:13 }}>No trucks. Add them in the Trucks section.</div>
                        ) : visible.length === 0 ? (
                          <div style={{ padding:"28px 16px", textAlign:"center", color:"#bbb", fontSize:13 }}>No trucks in this condition.</div>
                        ) : visible.map(t => {
                          const c = liveStatusMeta(t.last_status);
                          const isSel = liveSelTruck === t.id;
                          const dn = driverByTruck[t.id];
                          return (
                            <div key={t.id} onClick={() => setLiveSelTruck(isSel ? null : t.id)}
                              style={{ padding:"11px 14px", borderBottom:"1px solid #f4f4f4", cursor:"pointer", background: isSel ? "#f0f6fc" : "#fff", borderLeft: `3px solid ${isSel ? c.dot : "transparent"}` }}>
                              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                                <span style={{ width:8, height:8, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
                                <span style={{ fontWeight:700, fontSize:13 }}>🚛 {t.name}</span>
                                {t.plate && <span style={{ fontSize:11, color:"#aaa", fontFamily:"monospace" }}>{t.plate}</span>}
                              </div>
                              <div style={{ display:"flex", alignItems:"center", gap:6, margin:"4px 0 2px" }}>
                                <span style={{ fontSize:10.5, fontWeight:700, color:c.text, background:c.bg, borderRadius:20, padding:"1px 8px" }}>{c.l}</span>
                                <span style={{ fontSize:11, color:"#999" }}>{timeAgo(t.last_location_at)}</span>
                              </div>
                              {t.last_location && <div style={{ fontSize:11.5, color:"#666", lineHeight:1.4 }}>{t.last_location}</div>}
                              <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:4 }}>
                                {dn && <span style={{ fontSize:11, color:"#888" }}>🧑‍✈️ {dn}</span>}
                                <button onClick={(e) => { e.stopPropagation(); openLocModal(t); }} style={{ fontSize:11, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline", marginLeft:"auto" }}>Update location</button>
                              </div>
                            </div>
                          );
                        })}
                        {noLoc.length > 0 && (
                          <div style={{ padding:"10px 14px", fontSize:11.5, color:"#bbb", borderTop:"1px solid #f4f4f4" }}>
                            {noLoc.length} truck(s) with no location set{noLoc.length ? ": " : ""}
                            {noLoc.map((t, i) => (
                              <span key={t.id}>{i ? ", " : ""}<button onClick={() => openLocModal(t)} style={{ color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline", fontSize:11.5 }}>{t.name}</button></span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Map */}
                    <div>
                      <TruckLiveMap trucks={visible} selected={liveSelTruck} onSelect={setLiveSelTruck} />
                      <div style={{ display:"flex", gap:14, flexWrap:"wrap", fontSize:11, color:"#666", padding:"8px 4px 0" }}>
                        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:"50%", background:"#1A8A4E" }} />En movimiento</span>
                        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:"50%", background:"#E24B4A" }} />Detenido</span>
                        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:"50%", background:"#9aa3ad" }} />Sin datos</span>
                        <span style={{ marginLeft:"auto", color:"#aaa" }}>Manual / last-known location · ready for Verizon API</span>
                      </div>
                    </div>
                  </div>
                </>
              );
            })() : shown.length === 0 ? (
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>{tripsView === "active" ? "No active trips. Create one with “+ Trip”." : tripsView === "unassigned" ? "No unassigned trips. Every trip has a truck and a driver." : "No trips."}</div>
            ) : (tripsView === "active" || tripsView === "unassigned") ? (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(360px,1fr))", gap:14 }}>
                {shown.map(t => {
                  const c = tripCalc(t);
                  const truck = truckById[t.truck_id];
                  const driverNm = driverById[t.driver_id]?.name || "";
                  const grpLink = driverById[t.driver_id]?.whatsapp_group_link;
                  return (
                    <div key={t.id} style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:10, marginBottom:10 }}>
                        <div>
                          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                            <button onClick={() => setTripDetailId(t.id)} style={{ fontSize:15, fontWeight:800, fontFamily:"monospace", color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{t.trip_number || `#${t.id}`}</button>
                            <TripBadge status={t.status} />
                          </div>
                          <div style={{ fontSize:12, color:"#888", marginTop:2 }}>🚛 {truck?.name || "no truck"}{driverNm ? ` · 🧑‍✈️ ${driverNm}` : ""}{t.departure_date ? ` · ${t.departure_date}` : ""}</div>
                        </div>
                        <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"flex-end" }}>
                          <Btn primary onClick={() => setTripDetailId(t.id)} style={{ padding:"4px 9px", fontSize:11 }}>Manage Loads</Btn>
                          <Btn onClick={() => openEditTrip(t)} style={{ padding:"4px 9px", fontSize:11 }}>Edit Trip</Btn>
                          <Btn disabled={tripStopsMissing} title={tripStopsMissing ? trAI("Run the setup SQL to enable custom stops", "Corré el setup SQL para habilitar paradas") : trAI("Add a maintenance, inspection, fuel… stop", "Agregar parada de mantenimiento, inspección, combustible…")} onClick={() => openAddStop(t)} style={{ padding:"4px 9px", fontSize:11 }}>➕ {trAI("Add stop", "Agregar parada")}</Btn>
                          {c.jobsIn.length
                            ? <Btn onClick={() => setTripRouteModal({ title: t.trip_number || `#${t.id}`, waypoints: tripRouteWaypoints(c.jobsIn, storageById), googleLink: tripRouteLink(c.jobsIn, storageById) })} style={{ padding:"4px 9px", fontSize:11 }}>🗺️ View route</Btn>
                            : <Btn disabled title="No jobs in this trip" style={{ padding:"4px 9px", fontSize:11 }}>🗺️ View route</Btn>}
                        </div>
                      </div>
                      {c.cap > 0 ? (
                        <div style={{ marginBottom:10 }}>
                          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:4 }}>
                            <b style={{ color: occColor(c.occPct || 0) }}>{c.occPct}% occupied</b>
                            <span style={{ color:"#888" }}>{Math.round(c.loadedCf).toLocaleString()} / {c.cap.toLocaleString()} CF</span>
                          </div>
                          <div style={{ background:"#f0f0f0", borderRadius:6, height:12, overflow:"hidden" }}><div style={{ background: occColor(c.occPct || 0), height:12, width:`${Math.min(100, c.occPct || 0)}%`, transition:"width .4s" }} /></div>
                        </div>
                      ) : <div style={{ fontSize:12, color:"#999", marginBottom:10 }}>Truck with no capacity set · {Math.round(c.totalCf).toLocaleString()} CF en el trip</div>}
                      {(() => { const seq = tripSequenceByTrip[t.id] || []; return (<>
                      <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Stops ({seq.length})</div>
                      <div style={{ border:"1px solid #f0f0f0", borderRadius:8, maxHeight:320, overflowY:"auto" }}>
                        {seq.length === 0 ? <div style={{ padding:"12px", fontSize:12, color:"#bbb" }}>No stops in this trip. Use “Edit” or “Add stop”.</div>
                          : seq.map((item, i) => <SeqRow key={item.key} trip={t} item={item} idx={i} seq={seq} />)}
                      </div>
                      </>); })()}
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginTop:10 }}>
                        <span style={{ color:"#666" }}>Total: <b>{Math.round(c.totalCf).toLocaleString()} CF</b></span>
                        <span style={{ color:"#666" }}>To collect: <b style={{ color:"#1A8A4E" }}>${Math.round(c.totalCollect).toLocaleString()}</b></span>
                      </div>
                      <div style={{ display:"flex", gap:8, marginTop:10 }}>
                        <a href={tripManifestLink(t, truck?.name, driverNm, c.jobsIn, c.loadedCf, c.occPct, c.totalCollect)} target="_blank" rel="noreferrer" style={{ textDecoration:"none", flex:1 }}><Btn primary style={{ width:"100%", justifyContent:"center" }}>💬 Send manifest to driver</Btn></a>
                        {t.status === "loading" && <Btn onClick={() => setTripStatus(t, "in_transit")}>Depart</Btn>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                    <thead><tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                      {["Trip #","Truck","Driver","Salida","Jobs","CF","To collect","Status",""].map((h,i) => <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {shown.map(t => { const c = tripCalc(t); return (
                        <tr key={t.id} style={{ borderBottom:"1px solid #fafafa" }}>
                          <td style={{ padding:"12px", fontFamily:"monospace", fontWeight:700 }}><button onClick={() => setTripDetailId(t.id)} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{t.trip_number || `#${t.id}`}</button></td>
                          <td style={{ padding:"12px" }}>{truckById[t.truck_id]?.name || "—"}</td>
                          <td style={{ padding:"12px" }}>{driverById[t.driver_id]?.name || "—"}</td>
                          <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{t.departure_date || "—"}</td>
                          <td style={{ padding:"12px" }}>{c.count}</td>
                          <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{Math.round(c.totalCf).toLocaleString()} CF</td>
                          <td style={{ padding:"12px", whiteSpace:"nowrap", color:"#1A8A4E", fontWeight:600 }}>${Math.round(c.totalCollect).toLocaleString()}</td>
                          <td style={{ padding:"12px" }}><TripBadge status={t.status} /></td>
                          <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                            <Btn onClick={() => setTripDetailId(t.id)} style={{ padding:"4px 10px", fontSize:12 }}>Open</Btn>
                            <Btn onClick={() => openEditTrip(t)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Edit</Btn>
                            <Btn danger onClick={() => deleteTrip(t)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Delete</Btn>
                          </td>
                        </tr>
                      ); })}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{shown.length} trip(s)</div>
              </div>
            )}
          </>
        );
      })()}

      {/* ───────────────────────── EXTRAS & COMMISSIONS ───────────────────────── */}
      {page === "extras" && (() => {
        const monthLabel = (() => { if (!exMonth) return "All months"; const [y, m] = exMonth.split("-"); return m ? `${MONTHS_ES[parseInt(m) - 1]} ${y}` : exMonth; })();
        const pendingComm = jobExtras.filter(e => e.active !== false && extraPending(e));
        const driverIds = exDriver ? [Number(exDriver)] : driversList.map(d => d.id);
        const allGroups = [...extraJobGroups.values()];
        const searchQ = exSearch.trim().toLowerCase();
        const curMonth = today().slice(0, 7);
        const toggleExp = (key) => setExtrasTabExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
        const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
        // Driver sections → grouped by month → one entry per job (with that driver's active extras).
        const sections = driverIds.map(did => {
          const driver = driverById[did];
          if (!driver) return null;
          const byMonth = {};
          let totalAmt = 0, totalComm = 0;
          for (const g of allGroups) {
            if (searchQ && !((g.job_number || "").toLowerCase().includes(searchQ) || (g.customer || "").toLowerCase().includes(searchQ))) continue;
            const mo = groupMonth(g);
            if (exMonth && mo !== exMonth) continue;
            const exs = (extrasByJobKey[g.key] || []).filter(e => e.driver_id === did && e.active !== false
              && (!exRep || String(e.rep_id) === String(exRep)) && (!exType || e.extra_type === exType));
            if (!exs.length) continue;
            const amt = exs.reduce((s, e) => s + numv(e.amount), 0);
            const comm = exs.reduce((s, e) => s + numv(e.driver_commission_amount), 0);
            const pending = exs.some(e => extraPending(e));
            totalAmt += amt; totalComm += comm;
            (byMonth[mo] = byMonth[mo] || []).push({ g, exs, amt, comm, pending });
          }
          const months = Object.keys(byMonth).sort().reverse().map(mo => {
            const mjobs = byMonth[mo].sort((a, b) => (a.g.job_number || "").localeCompare(b.g.job_number || ""));
            const [y, m] = mo.split("-");
            return { mo, label: m ? `${MONTHS_ES[parseInt(m) - 1]} ${y}` : mo, jobs: mjobs, totalAmt: mjobs.reduce((s, j) => s + j.amt, 0), totalComm: mjobs.reduce((s, j) => s + j.comm, 0) };
          });
          return { driver, did, months, totalAmt, totalComm };
        }).filter(Boolean).filter(s => s.months.length);
        // Rep / back-office view: group by rep employee → jobs they were involved in.
        const repIds = exRep ? [Number(exRep)] : employees.map(em => em.id);
        const repSections = repIds.map(rid => {
          const emp = empById[rid];
          if (!emp) return null;
          const jobsForRep = [];
          for (const g of allGroups) {
            if (exMonth && groupMonth(g) !== exMonth) continue;
            if (searchQ && !((g.job_number || "").toLowerCase().includes(searchQ) || (g.customer || "").toLowerCase().includes(searchQ))) continue;
            const exs = (extrasByJobKey[g.key] || []).filter(e => e.active !== false && String(e.rep_id) === String(rid)
              && (!exType || e.extra_type === exType) && (!exDriver || String(e.driver_id) === String(exDriver)));
            if (exs.length) jobsForRep.push({ g, extras: exs });
          }
          jobsForRep.sort((a, b) => (a.g.job_number || "").localeCompare(b.g.job_number || ""));
          let totalAmt = 0, totalComm = 0;
          for (const jf of jobsForRep) for (const e of jf.extras) { totalAmt += numv(e.amount); totalComm += numv(e.rep_commission_amount); }
          return { emp, rid, jobsForRep, totalAmt, totalComm };
        }).filter(Boolean).filter(s => s.jobsForRep.length);
        const mhead = { padding:"6px 6px", textAlign:"left", fontWeight:600, fontSize:10, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
        return (
          <>
            {extrasMissing && (
              <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span>For Extras & Commissions (job_extras + employees/reps), run the setup SQL once in Supabase.</span>
                <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
              </div>
            )}
            {pendingComm.length > 0 && (
              <div style={{ background:"#FFF8EC", border:"1px solid #F4DDB0", borderRadius:10, padding:"12px 14px", marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#854F0B", marginBottom:8 }}>⚠️ Extras collected via payment with no commission assigned ({pendingComm.length})</div>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {pendingComm.map(e => {
                    const g = extraJobGroups.get(jobKeyByRowId[e.job_id]);
                    return (
                      <div key={e.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12.5, color:"#7A5512", flexWrap:"wrap" }}>
                        <button onClick={() => g && setJobDetailKey(g.key)} style={{ fontFamily:"monospace", fontWeight:700, color:"#854F0B", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{g?.job_number || ("#"+(e.job_id||"—"))}</button>
                        <span>{g?.customer || ""}</span>
                        <span style={{ fontWeight:700 }}>{extraTypeLabel(e.extra_type)}</span>
                        <span style={{ fontWeight:700 }}>{money(e.amount) || "$0"}</span>
                        <span style={{ fontSize:9.5, fontWeight:700, color:"#6D28D9", background:"#EDE9FE", borderRadius:20, padding:"1px 7px" }}>Collected via payment</span>
                        <span style={{ marginLeft:"auto" }}><Btn primary style={{ padding:"4px 11px", fontSize:12 }} onClick={() => openCommAssign(e)}>Assign commission</Btn></span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:10, marginBottom:16 }}>
              {[
                { label:`Extras (${monthLabel})`, value:"$"+Math.round(extraMetrics.total).toLocaleString(), color:"#111" },
                { label:"Driver commissions", value:"$"+Math.round(extraMetrics.driverComm).toLocaleString(), color:"#1A8A4E" },
                { label:"Rep commissions", value:"$"+Math.round(extraMetrics.repComm).toLocaleString(), color:"#185FA5" },
                { label:"For the company", value:"$"+Math.round(extraMetrics.company).toLocaleString(), color:"#EF9F27" },
              ].map(mt => (
                <div key={mt.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                  <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{mt.label}</div>
                  <div style={{ fontSize:20, fontWeight:800, color:mt.color, marginTop:3 }}>{mt.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
              <select value={exDriver} onChange={e => setExDriver(e.target.value)} style={{ ...inp, width:"auto", minWidth:150 }}>
                <option value="">All drivers</option>
                {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <select value={exRep} onChange={e => setExRep(e.target.value)} style={{ ...inp, width:"auto", minWidth:140 }}>
                <option value="">All reps</option>
                {employees.map(em => <option key={em.id} value={em.id}>{em.name}</option>)}
              </select>
              <input type="month" value={exMonth} onChange={e => setExMonth(e.target.value)} style={{ ...inp, width:"auto" }} />
              {exMonth ? <button onClick={() => setExMonth("")} style={{ ...inp, width:"auto", cursor:"pointer", background:"#fff", color:"#888" }}>All months ✕</button> : <span style={{ fontSize:12, color:"#888", alignSelf:"center" }}>All months</span>}
              <select value={exType} onChange={e => setExType(e.target.value)} style={{ ...inp, width:"auto", minWidth:140 }}>
                <option value="">All types</option>
                {EXTRA_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
              <input value={exSearch} onChange={e => setExSearch(e.target.value)} placeholder="Search job # or client…" style={{ ...inp, width:"auto", minWidth:170 }} />
            </div>

            <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14 }}>
              {[["drivers","🧑‍✈️ Drivers"],["reps","👤 Reps / Back office"]].map(([v,l]) => (
                <button key={v} onClick={() => setExtrasTab(v)} style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: extrasTab===v?"#fff":"none", color: extrasTab===v?"#111":"#888", fontWeight: extrasTab===v?600:400, boxShadow: extrasTab===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
              ))}
            </div>

            {extrasMissing ? null : extrasTab === "reps" ? (
              employees.length === 0 ? (
                <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>No reps added. Add them with “Reps / Employees”.</div>
              ) : repSections.length === 0 ? (
                <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>No rep has extras for {monthLabel} with these filters.</div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
                  {repSections.map(sec => {
                    const jobsData = sec.jobsForRep.map(jf => ({ job_number: jf.g.job_number, customer: jf.g.customer, driverName: driverById[jf.extras[0]?.driver_id]?.name || "", extras: jf.extras }));
                    return (
                      <div key={sec.rid} style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderBottom:"1px solid #f0f0f0", flexWrap:"wrap", background:"#fafafa" }}>
                          <span style={{ fontSize:15, fontWeight:700 }}>👤 {sec.emp.name}</span>
                          {sec.emp.role && <span style={{ fontSize:11, color:"#888" }}>{sec.emp.role}</span>}
                          <span style={{ flex:1 }} />
                          <span style={{ fontSize:12, color:"#666" }}>Extras: <b>${Math.round(sec.totalAmt).toLocaleString()}</b></span>
                          <span style={{ fontSize:12, color:"#185FA5" }}>Commission: <b>${Math.round(sec.totalComm).toLocaleString()}</b></span>
                          <Btn onClick={() => copyRepExtras(sec.emp.name, monthLabel, jobsData)} style={{ padding:"4px 10px", fontSize:12 }}>📋 Copiar</Btn>
                          <Btn onClick={() => printRepExtras(sec.emp.name, monthLabel, jobsData)} style={{ padding:"4px 10px", fontSize:12 }}>🖨️ PDF</Btn>
                        </div>
                        <div style={{ padding:"6px 12px 12px" }}>
                          {sec.jobsForRep.map(jf => (
                            <div key={jf.g.key} style={{ marginTop:12 }}>
                              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:4, paddingLeft:2 }}>
                                <button onClick={() => setJobDetailKey(jf.g.key)} style={{ fontFamily:"monospace", fontWeight:700, fontSize:13, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{jf.g.job_number || "(ver)"}</button>
                                <span style={{ fontSize:13 }}>{jf.g.customer || "—"}</span>
                                {brokerName(jf.g.broker_id) && <span style={{ fontSize:11, color:"#888" }}>· {brokerName(jf.g.broker_id)}</span>}
                                {jf.g.date_in && <span style={{ fontSize:11, color:"#aaa" }}>· {jf.g.date_in}</span>}
                                {driverById[jf.extras[0]?.driver_id]?.name && <span style={{ fontSize:11, color:"#888" }}>· 🧑‍✈️ {driverById[jf.extras[0].driver_id].name}</span>}
                              </div>
                              <div style={{ overflowX:"auto", border:"1px solid #f0f0f0", borderRadius:8 }}>
                                <table style={{ width:"100%", borderCollapse:"collapse" }}>
                                  <thead><tr style={{ background:"#fbfbfb", borderBottom:"1px solid #f0f0f0" }}>
                                    {["Type", "Amount", "Generated by", "Driver", "Rep %", "Com. rep"].map((h, i) => <th key={i} style={mhead}>{h}</th>)}
                                  </tr></thead>
                                  <tbody>
                                    {jf.extras.map(e => (
                                      <tr key={e.id} style={{ borderBottom:"1px solid #f6f6f6" }}>
                                        <td style={{ padding:"6px 6px", fontSize:12, fontWeight:600, whiteSpace:"nowrap" }}>{extraTypeLabel(e.extra_type)}{e.extra_type === "other" && e.description ? ` · ${e.description}` : ""}</td>
                                        <td style={{ padding:"6px 6px", fontSize:12 }}>{money(e.amount) || "$0"}</td>
                                        <td style={{ padding:"6px 6px", fontSize:12 }}>{genByLabel(e.generated_by)}</td>
                                        <td style={{ padding:"6px 6px", fontSize:12 }}>{driverById[e.driver_id]?.name || "—"}</td>
                                        <td style={{ padding:"6px 6px", fontSize:12 }}>{numv(e.rep_commission_pct)}%</td>
                                        <td style={{ padding:"6px 6px", fontSize:12, color:"#185FA5", fontWeight:700, whiteSpace:"nowrap" }}>{money(e.rep_commission_amount) || "$0"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                          <div style={{ marginTop:14, borderTop:"2px solid #eee" }}>
                            <div style={{ display:"flex", justifyContent:"space-between", padding:"8px 10px", fontSize:13, fontWeight:600, color:"#444" }}>
                              <span>TOTAL EXTRAS</span><span>${Math.round(sec.totalAmt).toLocaleString()}</span>
                            </div>
                            <div style={{ display:"flex", justifyContent:"space-between", padding:"8px 10px", fontSize:13, fontWeight:700, background:"#FEF9C3", borderRadius:8 }}>
                              <span>COMMISSION {sec.emp.name}</span><span style={{ color:"#185FA5" }}>${Math.round(sec.totalComm).toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : extrasMissing ? null : driversList.length === 0 ? (
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>No drivers yet. Add drivers and assign them to jobs.</div>
            ) : sections.length === 0 ? (
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>Sin extras para {exMonth ? monthLabel : "no month"} with these filters.</div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {sections.map(sec => {
                  const dExpanded = extrasTabExpanded.has("d:" + sec.did);
                  const allJobsData = sec.months.flatMap(mn => mn.jobs.map(j => ({ job_number: j.g.job_number, customer: j.g.customer, extras: j.exs })));
                  const periodLabel = exMonth ? monthLabel : "All months";
                  const toggleMonth = (mKey, isOpen) => setExtrasTabExpanded(prev => { const n = new Set(prev); if (isOpen) { n.delete(mKey); n.add("c:" + mKey); } else { n.delete("c:" + mKey); n.add(mKey); } return n; });
                  return (
                    <div key={sec.did} style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
                      {/* Driver header — collapsible */}
                      <div onClick={() => toggleExp("d:" + sec.did)} style={{ display:"flex", alignItems:"center", gap:11, padding:"12px 16px", cursor:"pointer", background:"#fafafa", borderBottom: dExpanded ? "1px solid #f0f0f0" : "none", flexWrap:"wrap" }}>
                        <span style={{ width:34, height:34, borderRadius:"50%", background:"#111", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, flexShrink:0 }}>{initials(sec.driver.name)}</span>
                        <span style={{ fontSize:15, fontWeight:700 }}>{sec.driver.name}</span>
                        <span style={{ fontSize:11, color:"#aaa" }}>{dExpanded ? "▾" : "▸"}</span>
                        <span style={{ flex:1 }} />
                        <span style={{ fontSize:12, color:"#666" }}>Extras <b>${Math.round(sec.totalAmt).toLocaleString()}</b></span>
                        <span style={{ fontSize:11.5, fontWeight:700, color:"#1A8A4E", background:"#EAF3DE", borderRadius:20, padding:"3px 11px" }}>Commission ${Math.round(sec.totalComm).toLocaleString()}</span>
                      </div>
                      {dExpanded && (
                        <div style={{ padding:"8px 12px 12px" }}>
                          <div style={{ display:"flex", justifyContent:"flex-end", gap:6, marginBottom:6 }}>
                            <Btn onClick={() => copyDriverExtras(sec.driver.name, periodLabel, allJobsData)} style={{ padding:"3px 9px", fontSize:11.5 }}>📋 Copiar</Btn>
                            <Btn onClick={() => printDriverExtras(sec.driver.name, periodLabel, allJobsData)} style={{ padding:"3px 9px", fontSize:11.5 }}>🖨️ PDF</Btn>
                          </div>
                          {sec.months.map(mn => {
                            const mKey = "m:" + sec.did + ":" + mn.mo;
                            const open = extrasTabExpanded.has(mKey) ? true : extrasTabExpanded.has("c:" + mKey) ? false : (mn.mo === curMonth);
                            return (
                              <div key={mn.mo} style={{ border:"1px solid #f0f0f0", borderRadius:9, marginBottom:8, overflow:"hidden" }}>
                                <div onClick={() => toggleMonth(mKey, open)} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 11px", cursor:"pointer", background:"#fbfbfb" }}>
                                  <span style={{ fontSize:11, color:"#aaa" }}>{open ? "▾" : "▸"}</span>
                                  <span style={{ fontSize:12.5, fontWeight:700 }}>{mn.label}</span>
                                  <span style={{ flex:1 }} />
                                  <span style={{ fontSize:11.5, color:"#666" }}>Extras <b>${Math.round(mn.totalAmt).toLocaleString()}</b></span>
                                  <span style={{ fontSize:11.5, color:"#1A8A4E" }}>Commission <b>${Math.round(mn.totalComm).toLocaleString()}</b></span>
                                </div>
                                {open && (
                                  <div>
                                    {mn.jobs.map(j => (
                                      <div key={j.g.key} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 11px", borderTop:"1px solid #f6f6f6", flexWrap:"wrap" }}>
                                        <button onClick={() => setJobDetailKey(j.g.key)} style={{ fontFamily:"monospace", fontWeight:700, fontSize:12.5, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.g.job_number || "(ver)"}</button>
                                        <span style={{ fontSize:12.5, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.g.customer || "—"}</span>
                                        <span style={{ display:"flex", gap:4, flexWrap:"wrap" }}>{j.exs.map(e => <span key={e.id} onClick={() => openEditExtra(e)} style={{ cursor:"pointer" }} title="Edit extra"><ExtraTypeChip type={e.extra_type} amount={numv(e.amount)} /></span>)}</span>
                                        <span style={{ flex:1 }} />
                                        <span style={{ fontSize:12.5, color:"#666" }} title="Total collected">${Math.round(j.amt).toLocaleString()}</span>
                                        <span style={{ fontSize:12.5, fontWeight:700, color:"#1A8A4E" }} title="Driver commission">${Math.round(j.comm).toLocaleString()}</span>
                                        <span title={j.pending ? "Commission pending" : "Commission assigned"}>{j.pending ? "⚠️" : "✅"}</span>
                                        <button onClick={() => setJobDetailKey(j.g.key)} title="Edit" style={{ border:"none", background:"none", cursor:"pointer", color:"#185FA5", fontSize:13 }}>✏️</button>
                                      </div>
                                    ))}
                                    <div style={{ display:"flex", justifyContent:"space-between", padding:"8px 11px", borderTop:"2px solid #eee", fontSize:12.5, fontWeight:700, background:"#FEF9C3" }}>
                                      <span>Total {mn.label}</span>
                                      <span>Extras ${Math.round(mn.totalAmt).toLocaleString()} · Commission <span style={{ color:"#1A8A4E" }}>${Math.round(mn.totalComm).toLocaleString()}</span></span>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}

      {/* ───────────────────────── PAYMENTS ───────────────────────── */}
      {page === "payments" && (() => {
        const m = paymentMetrics;
        const tabFilter = (p) => payTab === "pending" ? !p.received : payTab === "received" ? p.received : payTab === "banked" ? (p.received && effectiveBanked(p)) : true;
        const pq = paySearch.trim().toLowerCase();
        const searchFilter = (p) => !pq || [p._g?.job_number, p._g?.customer, payRef(p)].filter(Boolean).join(" ").toLowerCase().includes(pq);
        const rows = paymentRows.filter(tabFilter).filter(searchFilter).sort((a, b) => (b.payment_date || "").localeCompare(a.payment_date || ""));
        // Jobs matching the search, to answer "does this job have a payment?" even when
        // it has zero payment rows (an empty table alone doesn't say if the job exists).
        const searchedJobs = pq ? [...extraJobGroups.values()].filter(g => (g.job_number || "").toLowerCase().includes(pq)).slice(0, 5) : [];
        // Weekly window (Mon–Sun) for the cash-flow summary.
        const td = today(); const dd = new Date(td + "T00:00:00"); const dow = dd.getDay();
        const mon = new Date(dd); mon.setDate(dd.getDate() - ((dow + 6) % 7));
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const wkStart = fmtDateLocal(mon), wkEnd = fmtDateLocal(sun);
        const inWeek = (s) => s && s >= wkStart && s <= wkEnd;
        let expWeek = 0, recvWeek = 0, bankWeek = 0;
        for (const g of extraJobGroups.values()) { if (g.status !== "cancelled" && (inWeek(g.delivery_date) || inWeek(g.pickup_date))) expWeek += jobExpected(g); }
        for (const p of payments) {
          if (p.received && inWeek(p.received_date || p.payment_date)) recvWeek += paymentNet(p);
          if (p.banked && inWeek(p.banked_date)) bankWeek += paymentNet(p);
        }
        const metricDefs = [
          { label:"Expected this month", value:"$"+Math.round(m.expected).toLocaleString(), color:"#666" },
          { label:"Received this month", value:"$"+Math.round(m.received).toLocaleString(), color:"#1A8A4E" },
          { label:"In circulation (not deposited)", value:"$"+Math.round(m.inCirc).toLocaleString(), color:"#E24B4A" },
          { label:"Deposited this month", value:"$"+Math.round(m.banked).toLocaleString(), color:"#185FA5" },
          { label:"Pending collection", value:"$"+Math.round(m.pending).toLocaleString(), color:"#EF9F27" },
          { label:"CC fees collected", value:"$"+Math.round(m.ccFees).toLocaleString(), color:"#7C3AED" },
        ];
        const th = { padding:"9px 10px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
        const td2 = { padding:"9px 10px", fontSize:12.5, verticalAlign:"middle" };
        const Toggle = ({ on, onClick, disabled }) => (
          <button onClick={onClick} disabled={disabled} style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, border:"none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, background: on ? "#EAF3DE" : "#F1F1F1", color: on ? "#3B6D11" : "#999" }}>{on ? "Yes" : "No"}</button>
        );
        // One payment row (also used for split children, slightly indented + tinted).
        const renderPayRow = (p, child = false) => (
          <tr key={p.id} style={{ borderBottom:"1px solid #fafafa", verticalAlign:"middle", background: child ? "#FBFAFE" : undefined }}>
            <td style={{ ...td2, paddingLeft: child ? 26 : td2.padding }}>{p._key ? <button onClick={() => setJobDetailKey(p._key)} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{child ? "↳ " : ""}{p._g?.job_number || "(ver)"}</button> : <span style={{ color:"#bbb" }}>{child ? "↳ " : ""}—</span>}</td>
            <td style={td2}>{p._g?.customer || "—"}</td>
            <td style={td2}>{brokerName(p._g?.broker_id) || "—"}</td>
            <td style={td2}>{p._g ? (jobDriverNames(p._g) || "—") : "—"}</td>
            <td style={td2}><ConceptBadge concept={p.concept} />{p.extra_type && p.concept === "extra" && <div style={{ fontSize:9.5, color:"#6D28D9", marginTop:2 }}>{extraTypeLabel(p.extra_type)}</div>}</td>
            <td style={td2}>
              <PaymentMethodBadge method={p.method} />
              {p.check_type && <div style={{ fontSize:9.5, color:"#999", marginTop:2 }}>{checkTypeLabel(p.check_type)}</div>}
              {p.mo_type && <div style={{ fontSize:9.5, color:"#999", marginTop:2 }}>{moTypeLabel(p.mo_type)}</div>}
            </td>
            <td style={{ ...td2, fontFamily:"monospace", fontSize:11.5, whiteSpace:"nowrap" }}>{payRef(p) || "—"}</td>
            <td style={{ ...td2, fontSize:11.5, whiteSpace:"nowrap" }}>{payIssuer(p) || "—"}</td>
            <td style={{ ...td2, textAlign:"center" }}>{payPhotoUrl(p) ? <button onClick={() => setPayPhotoView(payPhotoUrl(p))} title="View document" style={{ border:"none", background:"none", cursor:"pointer", fontSize:15 }}>📷</button> : <span style={{ color:"#ddd" }}>—</span>}</td>
            <td style={{ ...td2, whiteSpace:"nowrap", fontWeight:600 }}>{money(p.amount) || "$0"}</td>
            <td style={{ ...td2, whiteSpace:"nowrap", color: numv(p.discount) ? "#E24B4A" : "#ccc" }}>{numv(p.discount) ? "-"+money(p.discount) : "—"}</td>
            <td style={{ ...td2, whiteSpace:"nowrap", fontWeight:700, color:"#1A8A4E" }}>${p._net.toLocaleString()}</td>
            <td style={{ ...td2, whiteSpace:"nowrap" }}>{p.payment_date || "—"}</td>
            <td style={td2}><Toggle on={!!p.received} onClick={() => togglePayReceived(p)} /></td>
            <td style={td2}>{p.received_by || "—"}</td>
            <td style={td2}>{!p.banked && isPhysical(p.method) ? (p.cash_with_whom || "—") : "—"}</td>
            <td style={td2}><Toggle on={!!p.banked} disabled={!p.received} onClick={() => togglePayBanked(p)} /></td>
            <td style={{ ...td2, whiteSpace:"nowrap" }}>{p.banked_date || "—"}</td>
            <td style={td2}>{p.bank_account || "—"}</td>
            <td style={{ ...td2, whiteSpace:"nowrap" }}>
              {p.concept === "on_account" && p.job_id && !allocMissing && can("payments","edit") && (
                <button onClick={() => openReallocatePayment(p)} title="Imputar este pago a cuenta contra los cargos del job" style={{ border:"1px solid #F4DDB0", background:"#FFF6E8", color:"#854F0B", fontSize:11, fontWeight:700, borderRadius:6, padding:"2px 8px", cursor:"pointer", marginRight:4 }}>Asignar</button>
              )}
              <button onClick={() => openEditPayment(p)} title="Edit" style={{ border:"none", background:"none", cursor:"pointer", color:"#185FA5", fontSize:13 }}>✏️</button>
              <button onClick={() => deletePaymentRow(p)} title="Delete" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:15, marginLeft:4 }}>×</button>
            </td>
          </tr>
        );
        // Group split-payment rows (share a split_group) into one expandable parent.
        const splitMap = {};
        for (const p of rows) { if (p.split_group) (splitMap[p.split_group] = splitMap[p.split_group] || []).push(p); }
        const seenSplit = new Set();
        const displayItems = [];
        for (const p of rows) {
          if (p.split_group && (splitMap[p.split_group] || []).length > 1) {
            if (seenSplit.has(p.split_group)) continue;
            seenSplit.add(p.split_group);
            const grp = splitMap[p.split_group];
            displayItems.push({ type:"group", key:"g"+p.split_group, group:p.split_group, rows:grp, total: grp.reduce((s, x) => s + x._net, 0), rep: grp[0] });
          } else {
            displayItems.push({ type:"single", p });
          }
        }
        const toggleSplit = (gid) => setExpandedSplits(prev => { const n = new Set(prev); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
        return (
          <>
            {paymentsMissing && (
              <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span>For Payments (collections, circulation and deposits), run the setup SQL once in Supabase.</span>
                <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:10, marginBottom:16 }}>
              {metricDefs.map(mt => (
                <div key={mt.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                  <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{mt.label}</div>
                  <div style={{ fontSize:19, fontWeight:800, color:mt.color, marginTop:3 }}>{mt.value}</div>
                </div>
              ))}
            </div>

            {/* Reconciliation note: the three figures use different time windows by design. */}
            <div style={{ background:"#F5F7FA", border:"1px solid #e3e8ef", borderRadius:10, padding:"10px 13px", marginBottom:16, fontSize:12, color:"#556", lineHeight:1.5 }}>
              💡 <b>How these reconcile:</b> “Received this month” and “Deposited this month” only count the current month. “In circulation” shows <b>all</b> undeposited cash/checks regardless of when they were received, so it won’t always equal Received − Deposited.
              {" "}Of this month’s <b>${Math.round(m.received).toLocaleString()}</b> received, <b>${Math.round(m.inCircThisMonth).toLocaleString()}</b> is still in circulation and the rest has been deposited. Digital payments (Zelle, Venmo, wire, card…) are auto-deposited on receipt; cash, checks and money orders stay in circulation until marked deposited.
            </div>

            {stalePayments.length > 0 && (
              <div style={{ background:"#FCEBEB", border:"1px solid #E24B4A", borderRadius:10, padding:"12px 14px", marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#A32D2D", marginBottom:6 }}>⚠️ Received, not deposited for 7+ days ({stalePayments.length})</div>
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {stalePayments.map(p => (
                    <div key={p.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:"#7A2222", flexWrap:"wrap" }}>
                      <button onClick={() => p._key && setJobDetailKey(p._key)} style={{ fontFamily:"monospace", fontWeight:700, color:"#A32D2D", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{p._g?.job_number || ("#"+(p.job_id||"—"))}</button>
                      <span style={{ fontWeight:700 }}>${p._net.toLocaleString()}</span>
                      <span>· {payMethodLabel(p.method)}</span>
                      <span>· {(p.cash_with_whom || p.received_by || "—")}</span>
                      <span style={{ marginLeft:"auto", fontWeight:700 }}>{daysSince(p.received_date || p.payment_date)} days</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
              <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, flexWrap:"wrap" }}>
                {[["all","All"],["pending","Pending"],["received","Received"],["circulation","In circulation"],["banked","Deposited"]].map(([v,l]) => (
                  <button key={v} onClick={() => setPayTab(v)} style={{ fontSize:13, padding:"6px 13px", borderRadius:7, cursor:"pointer", border:"none", background: payTab===v?"#fff":"none", color: payTab===v?"#111":"#888", fontWeight: payTab===v?600:400, boxShadow: payTab===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
                ))}
              </div>
              <input style={{ ...inp, minWidth:230 }} value={paySearch} onChange={e => setPaySearch(e.target.value)} placeholder="🔎 Search job # / client / ref…" />
              {paySearch && <button onClick={() => setPaySearch("")} title="Clear search" style={{ border:"none", background:"none", cursor:"pointer", color:"#999", fontSize:15 }}>✕</button>}
            </div>

            {/* Search verdict: does each matching job have payments loaded or not? */}
            {pq && searchedJobs.length === 0 && (
              <div style={{ background:"#FEF9C3", border:"1px solid #FACC15", borderRadius:10, padding:"10px 14px", marginBottom:12, fontSize:12.5, color:"#854D0E" }}>
                ⚠️ Ningún job coincide con “{paySearch.trim()}”. Revisá el número de job.
              </div>
            )}
            {searchedJobs.map(g => {
              const pays = paymentsByJobKey[g.key] || [];
              const totalNet = pays.reduce((s, p) => s + paymentNet(p), 0);
              const receivedNet = pays.filter(p => p.received).reduce((s, p) => s + paymentNet(p), 0);
              const expected = jobExpected(g);
              const has = pays.length > 0;
              return (
                <div key={g.key} style={{ background: has ? "#F0FAF4" : "#FCEBEB", border:`1px solid ${has ? "#CDEBD8" : "#E24B4A"}`, borderRadius:10, padding:"10px 14px", marginBottom:10, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", fontSize:12.5 }}>
                  <span style={{ fontSize:15 }}>{has ? "✅" : "🚫"}</span>
                  <button onClick={() => setJobDetailKey(g.key)} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline", fontSize:13 }}>{g.job_number || "(sin #)"}</button>
                  <span style={{ color:"#555" }}>{g.customer || "—"}</span>
                  {g.status === "cancelled" && <StatusBadge status={g.status} />}
                  {has ? (
                    <span style={{ color:"#1A8A4E", fontWeight:700 }}>{pays.length} pago(s) · ${Math.round(totalNet).toLocaleString()}{receivedNet !== totalNet ? ` (recibido $${Math.round(receivedNet).toLocaleString()})` : ""}</span>
                  ) : (
                    <span style={{ color:"#A32D2D", fontWeight:700 }}>Sin pagos cargados</span>
                  )}
                  {expected > 0 && <span style={{ color:"#777" }}>Esperado ${Math.round(expected).toLocaleString()} · Pendiente ${Math.max(0, Math.round(expected - receivedNet)).toLocaleString()}</span>}
                  <span style={{ flex:1 }} />
                  {can("payments","create") && !paymentsMissing && (
                    <Btn primary style={{ padding:"5px 11px", fontSize:12 }} onClick={() => openAddPayment({ job_id: g.repId })}>+ Payment</Btn>
                  )}
                </div>
              );
            })}

            {paymentsMissing ? null : payTab === "circulation" ? (
              circulation.length === 0 ? (
                <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>No cash/checks in circulation. All deposited. 🎉</div>
              ) : (
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(330px,1fr))", gap:14 }}>
                  {circulation.map(person => {
                  const selItems = person.items.filter(p => depositSel.has(p.id));
                  const selTotal = selItems.reduce((s, p) => s + p._net, 0);
                  const allSel = selItems.length === person.items.length;
                  return (
                    <div key={person.name} style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                        <span style={{ fontSize:15, fontWeight:700 }}>👤 {person.name}</span>
                        <button onClick={() => setDepositSel(prev => { const n = new Set(prev); person.items.forEach(p => allSel ? n.delete(p.id) : n.add(p.id)); return n; })} style={{ border:"none", background:"none", cursor:"pointer", fontSize:11, color:"#185FA5", fontWeight:600, padding:0 }}>{allSel ? "Clear" : "Select all"}</button>
                        <span style={{ flex:1 }} />
                        <span style={{ fontSize:18, fontWeight:800, color:"#E24B4A" }}>${Math.round(person.total).toLocaleString()}</span>
                      </div>
                      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
                        {person.cash > 0 && <span style={{ fontSize:11, background:"#EAF3DE", color:"#3B6D11", borderRadius:20, padding:"2px 9px", fontWeight:600 }}>Cash ${Math.round(person.cash).toLocaleString()}</span>}
                        {person.check > 0 && <span style={{ fontSize:11, background:"#E6F1FB", color:"#185FA5", borderRadius:20, padding:"2px 9px", fontWeight:600 }}>Checks ${Math.round(person.check).toLocaleString()}</span>}
                        {person.money_order > 0 && <span style={{ fontSize:11, background:"#E0F2F4", color:"#0E7490", borderRadius:20, padding:"2px 9px", fontWeight:600 }}>Money orders ${Math.round(person.money_order).toLocaleString()}</span>}
                      </div>
                      <div style={{ border:"1px solid #f0f0f0", borderRadius:8, overflow:"hidden", marginBottom:10 }}>
                        {person.items.map(p => {
                          const detail = p.method === "check"
                            ? [checkTypeLabel(p.check_type), payRef(p) && `#${payRef(p)}`, p.check_bank].filter(Boolean).join(" · ")
                            : p.method === "money_order"
                            ? [moTypeLabel(p.mo_type), payRef(p) && `#${payRef(p)}`].filter(Boolean).join(" · ")
                            : "";
                          return (
                            <div key={p.id} style={{ padding:"7px 10px", borderBottom:"1px solid #f6f6f6", fontSize:12, background: depositSel.has(p.id) ? "#F0FAF4" : undefined }}>
                              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                                <input type="checkbox" checked={depositSel.has(p.id)} onChange={() => toggleDepositSel(p.id)} title="Tick to deposit" style={{ cursor:"pointer", accentColor:"#1A8A4E" }} />
                                <button onClick={() => p._key && setJobDetailKey(p._key)} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{p._g?.job_number || "(ver)"}</button>
                                <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{p._g?.customer || "—"}</span>
                                <PaymentMethodBadge method={p.method} />
                                {payPhotoUrl(p) && <button onClick={() => setPayPhotoView(payPhotoUrl(p))} title="View document" style={{ border:"none", background:"none", cursor:"pointer", fontSize:13 }}>📷</button>}
                                <span style={{ fontWeight:700 }}>${p._net.toLocaleString()}</span>
                                <span style={{ color:"#999", whiteSpace:"nowrap" }}>{daysSince(p.received_date || p.payment_date)}d</span>
                              </div>
                              {detail && <div style={{ fontSize:10.5, color:"#888", marginTop:2, paddingLeft:2 }}>{detail}</div>}
                            </div>
                          );
                        })}
                      </div>
                      {selItems.length > 0 && (
                        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:10, background:"#F0FAF4", border:"1px solid #CDEBD8", borderRadius:8, padding:"8px 10px" }}>
                          <select value={depositForm.bank_account} onChange={e => setDepositForm(f => ({ ...f, bank_account:e.target.value }))} style={{ fontSize:12, padding:"5px 7px", borderRadius:7, border:"1px solid #ddd", flex:1, minWidth:120 }}>
                            <option value="">— Account (optional) —</option>
                            {payAccounts.filter(a => a.active !== false).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                          </select>
                          <input type="date" value={depositForm.date || today()} onChange={e => setDepositForm(f => ({ ...f, date:e.target.value }))} style={{ fontSize:12, padding:"5px 7px", borderRadius:7, border:"1px solid #ddd" }} />
                          <Btn primary onClick={() => depositSelected(selItems.map(p => p.id))} style={{ padding:"6px 12px", fontSize:12 }}>✓ Deposit {selItems.length} · ${Math.round(selTotal).toLocaleString()}</Btn>
                        </div>
                      )}
                      <a href={"https://wa.me/?text=" + encodeURIComponent(`Hi ${person.name}, you currently have $${Math.round(person.total).toLocaleString()} in circulation:\n` + person.items.map(p => `• Job ${p._g?.job_number || p.job_id || "—"} — $${p._net.toLocaleString()} (${payMethodLabel(p.method)})`).join("\n") + `\nPlease deposit or deliver by end of week. Thank you.`)} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn primary style={{ width:"100%", justifyContent:"center" }}>💬 Request deposit</Btn></a>
                    </div>
                  );})}
                </div>
              )
            ) : (
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                    <thead><tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                      {["Job #","Client","Broker","Driver","Concept","Method","Ref #","Issuer","Photo","Amount","Desc.","Net","Date","Received","Received by","Who has it","Deposited","Dep. date","Account","Actions"].map((h, i) => <th key={i} style={th}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={20} style={{ padding:"40px", textAlign:"center", color:"#bbb" }}>Sin pagos en este filtro.</td></tr>
                      ) : displayItems.flatMap(it => {
                        if (it.type === "single") return [renderPayRow(it.p)];
                        const rep = it.rep, open = expandedSplits.has(it.group);
                        const parent = (
                          <tr key={it.key} style={{ borderBottom:"1px solid #f3f0fb", verticalAlign:"middle", background:"#FBFAFE" }}>
                            <td style={td2}>{rep._key ? <button onClick={() => setJobDetailKey(rep._key)} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{rep._g?.job_number || "(ver)"}</button> : <span style={{ color:"#bbb" }}>—</span>}</td>
                            <td style={td2}>{rep._g?.customer || "—"}</td>
                            <td style={td2}>{brokerName(rep._g?.broker_id) || "—"}</td>
                            <td style={td2}>{rep._g ? (jobDriverNames(rep._g) || "—") : "—"}</td>
                            <td style={td2}>
                              <button onClick={() => toggleSplit(it.group)} style={{ border:"none", background:"none", cursor:"pointer", fontSize:12, color:"#6D28D9", fontWeight:700, padding:0 }}>{open ? "▾" : "▸"} <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 8px", borderRadius:20, background:"#EDE9FE", color:"#6D28D9" }}>Split ({it.rows.length})</span></button>
                            </td>
                            <td style={td2} colSpan={4}><span style={{ fontSize:11.5, color:"#999" }}><PaymentMethodBadge method={rep.method} /> · {it.rows.length} lines</span></td>
                            <td style={{ ...td2, whiteSpace:"nowrap", fontWeight:700 }}>{money(it.total) || "$0"}</td>
                            <td style={td2}><span style={{ color:"#ccc" }}>—</span></td>
                            <td style={{ ...td2, whiteSpace:"nowrap", fontWeight:800, color:"#6D28D9" }}>${Math.round(it.total).toLocaleString()}</td>
                            <td style={td2} colSpan={7}><span style={{ fontSize:11.5, color:"#999" }}>{rep.payment_date || "—"}</span></td>
                            <td style={{ ...td2, whiteSpace:"nowrap" }}>
                              <button onClick={() => deleteSplitGroup(it.rows)} title="Delete split" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:15 }}>×</button>
                            </td>
                          </tr>
                        );
                        return open ? [parent, ...it.rows.map(p => renderPayRow(p, true))] : [parent];
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{rows.length} pago(s)</div>
              </div>
            )}

            {!paymentsMissing && (
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px", marginTop:18 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#666", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Weekly cash flow</div>
                <div style={{ fontSize:11, color:"#aaa", marginBottom:12 }}>{wkStart} → {wkEnd}</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10 }}>
                  {[
                    { l:"Expected this week", v:expWeek, c:"#666" },
                    { l:"Received this week", v:recvWeek, c:"#1A8A4E" },
                    { l:"In circulation (total)", v:m.inCirc, c:"#E24B4A" },
                    { l:"Deposited this week", v:bankWeek, c:"#185FA5" },
                    { l:"Projection if everything is deposited", v:m.banked + m.inCirc, c:"#7C3AED" },
                  ].map(x => (
                    <div key={x.l} style={{ border:"1px solid #f0f0f0", borderRadius:8, padding:"10px 12px" }}>
                      <div style={{ fontSize:10.5, color:"#999", fontWeight:500 }}>{x.l}</div>
                      <div style={{ fontSize:16, fontWeight:800, color:x.c, marginTop:2 }}>${Math.round(x.v).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* ───────────────────────── LEGAL & COMPLIANCE ───────────────────────── */}
      {page === "compliance" && (() => {
        const m = complianceMetrics;
        const cell = (entityType, entityId, dt) => {
          const d = docFor(entityType, entityId, dt);
          return <DocCell key={dt} label={docTypeLabel(dt)} doc={d}
            onAdd={() => openAddDoc({ entity_type: entityType, entity_id: entityId, document_type: dt, document_name: docTypeLabel(dt) })}
            onEdit={() => { const x = docFor(entityType, entityId, dt); if (x) openEditDoc(x); }}
            onFile={(f) => { const x = docFor(entityType, entityId, dt); x ? uploadComplianceDoc(f, x) : createDocAndUpload(entityType, entityId, dt, f); }} />;
        };
        const gridStyle = { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))", gap:8, marginTop:10 };
        const cardStyle = { background:"#fff", border:"1px solid #efefef", borderRadius:12, padding:"14px 16px", marginBottom:14 };
        const chip = { fontSize:11, color:"#666", background:"#f5f5f5", borderRadius:20, padding:"2px 9px" };
        const tabs = [["companies","Companies"],["trucks","Trucks"],["drivers","Drivers"],["all","All documents"]];
        // All-documents tab data
        const allRows = complianceDocs.map(d => ({ d, st: docStatus(d), days: docDaysToExpiry(d), name: entityName(d.entity_type, d.entity_id) }))
          .filter(r => !docFilterEntity || r.d.entity_type === docFilterEntity)
          .filter(r => !docFilterStatus || r.st === docFilterStatus)
          .filter(r => docFilterDays === "" || (r.days !== null && r.days <= Number(docFilterDays)))
          .sort((a, b) => (a.d.expiry_date || "9999").localeCompare(b.d.expiry_date || "9999"));
        const th = { padding:"9px 10px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
        const td = { padding:"9px 10px", fontSize:12.5, verticalAlign:"middle" };
        return (
          <>
            {complianceMissing && (
              <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span>For Legal & Compliance (companies + documents), run the setup SQL once in Supabase.</span>
                <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:10, marginBottom:16 }}>
              {[
                { label:"Active companies", value: m.activeCompanies, color:"#111" },
                { label:"Documentos vencidos", value: m.expired, color:"#E24B4A" },
                { label:"Expiring in 30 days", value: m.expiringSoon, color:"#EF9F27" },
                { label:"Up to date", value: m.upToDate, color:"#1A8A4E" },
              ].map(mt => (
                <div key={mt.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                  <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{mt.label}</div>
                  <div style={{ fontSize:22, fontWeight:800, color:mt.color, marginTop:3 }}>{mt.value}</div>
                </div>
              ))}
            </div>

            {!compBannerDismissed && complianceAlerts.length > 0 && (
              <div style={{ background:"#FCEBEB", border:"1px solid #E24B4A", borderRadius:10, padding:"12px 14px", marginBottom:16 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span style={{ fontSize:13, fontWeight:700, color:"#A32D2D" }}>⚠️ {complianceAlerts.length} document(s) expired or expiring soon (≤7 days)</span>
                  <button onClick={() => setCompBannerDismissed(true)} style={{ marginLeft:"auto", border:"none", background:"none", cursor:"pointer", color:"#A32D2D", fontSize:16, lineHeight:1 }}>×</button>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  {complianceAlerts.map(a => (
                    <div key={a.doc.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:"#7A2222", flexWrap:"wrap" }}>
                      <span style={{ fontSize:10, fontWeight:700, color:"#A32D2D", background:"#fff", borderRadius:20, padding:"1px 7px" }}>{ENTITY_LABELS[a.doc.entity_type] || a.doc.entity_type}</span>
                      <b>{a.name}</b>
                      <span>· {docTypeLabel(a.doc.document_type)}</span>
                      <span style={{ marginLeft:"auto", fontWeight:700 }}>{a.status === "expired" ? `Overdue ${Math.abs(a.days)} days ago` : `Expires in ${a.days} days`}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14, flexWrap:"wrap" }}>
              {tabs.map(([v,l]) => (
                <button key={v} onClick={() => setCompTab(v)} style={{ fontSize:13, padding:"6px 13px", borderRadius:7, cursor:"pointer", border:"none", background: compTab===v?"#fff":"none", color: compTab===v?"#111":"#888", fontWeight: compTab===v?600:400, boxShadow: compTab===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
              ))}
            </div>

            {complianceMissing ? null : compTab === "companies" ? (
              companies.length === 0 ? (
                <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>No companies. Add one with “+ Company”.</div>
              ) : companies.map(c => (
                <div key={c.id} style={cardStyle}>
                  <div style={{ display:"flex", alignItems:"flex-start", gap:10, flexWrap:"wrap" }}>
                    <div style={{ flex:1, minWidth:200 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                        <span style={{ fontSize:16, fontWeight:800 }}>🏢 {c.name}</span>
                        <ComplianceBadge status={entityStatus("company", c.id)} />
                        {c.active === false && <span style={{ fontSize:10.5, color:"#888", background:"#f1f1f1", borderRadius:20, padding:"2px 8px" }}>Inactiva</span>}
                      </div>
                      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:7 }}>
                        {c.dot_number && <span style={chip}>DOT {c.dot_number}</span>}
                        {c.mc_number && <span style={chip}>MC {c.mc_number}</span>}
                        {c.ein && <span style={chip}>EIN {c.ein}</span>}
                        {c.state && <span style={chip}>{c.state}</span>}
                        {c.phone && <span style={chip}>{c.phone}</span>}
                      </div>
                    </div>
                    <div style={{ display:"flex", gap:6 }}>
                      <Btn onClick={() => openEditCompany(c)} style={{ padding:"4px 10px", fontSize:12 }}>Edit</Btn>
                      <Btn danger onClick={() => deleteCompany(c)} style={{ padding:"4px 10px", fontSize:12 }}>Delete</Btn>
                    </div>
                  </div>
                  <div style={gridStyle}>{DOC_GRID.company.map(dt => cell("company", c.id, dt))}</div>
                </div>
              ))
            ) : compTab === "trucks" ? (
              trucksList.length === 0 ? (
                <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>No trucks. Load them on the Trucks page.</div>
              ) : trucksList.map(tk => (
                <div key={tk.id} style={cardStyle}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <span style={{ fontSize:16, fontWeight:800 }}>🚛 {tk.name}</span>
                    <ComplianceBadge status={entityStatus("truck", tk.id)} />
                    {[tk.license_plate || tk.plate, tk.vin, truckSubtitle(tk)].filter(Boolean).map((x, i) => <span key={i} style={chip}>{x}</span>)}
                  </div>
                  <div style={gridStyle}>{DOC_GRID.truck.map(dt => cell("truck", tk.id, dt))}</div>
                </div>
              ))
            ) : compTab === "drivers" ? (
              driversList.length === 0 ? (
                <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#bbb" }}>No drivers. They appear when assigned to jobs.</div>
              ) : driversList.map(dr => (
                <div key={dr.id} style={cardStyle}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <span style={{ fontSize:16, fontWeight:800 }}>🧑‍✈️ {dr.name}</span>
                    <ComplianceBadge status={entityStatus("driver", dr.id)} />
                    {dr.phone && <span style={chip}>{dr.phone}</span>}
                  </div>
                  <div style={gridStyle}>{DOC_GRID.driver.map(dt => cell("driver", dr.id, dt))}</div>
                </div>
              ))
            ) : (
              <>
                <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
                  <select value={docFilterEntity} onChange={e => setDocFilterEntity(e.target.value)} style={{ ...inp, width:"auto", minWidth:140 }}>
                    <option value="">Todas las entidades</option>
                    <option value="company">Companys</option><option value="truck">Camiones</option><option value="driver">Drivers</option>
                  </select>
                  <select value={docFilterStatus} onChange={e => setDocFilterStatus(e.target.value)} style={{ ...inp, width:"auto", minWidth:140 }}>
                    <option value="">All states</option>
                    <option value="expired">Expired</option><option value="expiring_soon">Expiring soon</option><option value="active">Up to date</option><option value="none">Sin fecha</option>
                  </select>
                  <select value={docFilterDays} onChange={e => setDocFilterDays(e.target.value)} style={{ ...inp, width:"auto", minWidth:150 }}>
                    <option value="">Cualquier vencimiento</option>
                    <option value="7">Expires in ≤7 days</option><option value="30">≤30 days</option><option value="60">≤60 days</option><option value="90">≤90 days</option>
                  </select>
                </div>
                <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                      <thead><tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                        {["Entity","Name","Doc type","N°","Issuer","Issued","Expiry","Status","Actions"].map((h,i) => <th key={i} style={th}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {allRows.length === 0 ? (
                          <tr><td colSpan={9} style={{ padding:"40px", textAlign:"center", color:"#bbb" }}>Sin documentos en este filtro.</td></tr>
                        ) : allRows.map(({ d, st, days, name }) => (
                          <tr key={d.id} style={{ borderBottom:"1px solid #fafafa" }}>
                            <td style={td}><span style={{ fontSize:10.5, fontWeight:700, color:"#555", background:"#f1f1f1", borderRadius:20, padding:"1px 8px" }}>{ENTITY_LABELS[d.entity_type] || d.entity_type}</span></td>
                            <td style={{ ...td, fontWeight:600 }}>{name}</td>
                            <td style={td}>{docTypeLabel(d.document_type)}</td>
                            <td style={{ ...td, fontFamily:"monospace", fontSize:12 }}>{d.document_number || "—"}</td>
                            <td style={td}>{d.issuer || "—"}</td>
                            <td style={{ ...td, whiteSpace:"nowrap" }}>{d.issue_date || "—"}</td>
                            <td style={{ ...td, whiteSpace:"nowrap" }}>{d.expiry_date || "—"}{days !== null && <span style={{ color: st==="expired"?"#A32D2D": st==="expiring_soon"?"#854F0B":"#aaa", fontSize:10.5 }}> ({days < 0 ? `hace ${-days}d` : `${days}d`})</span>}</td>
                            <td style={td}><ComplianceBadge status={st} /></td>
                            <td style={{ ...td, whiteSpace:"nowrap" }}>
                              {d.document_url && <a href={d.document_url} target="_blank" rel="noreferrer" style={{ color:"#185FA5", textDecoration:"none", marginRight:8 }}>Ver</a>}
                              <button onClick={() => openEditDoc(d)} style={{ border:"none", background:"none", cursor:"pointer", color:"#185FA5", fontSize:12 }}>Edit</button>
                              <button onClick={() => deleteDoc(d)} style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:15, marginLeft:4 }}>×</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{allRows.length} documento(s)</div>
                </div>
              </>
            )}
          </>
        );
      })()}

      {/* ───────────────────────── SETTINGS ───────────────────────── */}
      {page === "settings" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14, maxWidth:560 }}>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:14 }}>My account</div>

            <label style={{ fontSize:12, fontWeight:600, color:"#888", display:"block", marginBottom:6 }}>Email</label>
            <div style={{ fontSize:14, color:"#444", marginBottom:16 }}>{userEmail}</div>

            <label style={{ fontSize:12, fontWeight:600, color:"#888", display:"block", marginBottom:6 }}>Name</label>
            <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="Your name"
              style={{ fontSize:14, padding:"9px 12px", borderRadius:8, border:"1px solid #e5e5e5", width:"100%", maxWidth:340, outline:"none", boxSizing:"border-box", marginBottom:16 }} />

            <label style={{ fontSize:12, fontWeight:600, color:"#888", display:"block", marginBottom:6 }}>Display language</label>
            <div style={{ display:"flex", gap:8 }}>
              {[["en","🇺🇸 English"],["es","🇪🇸 Español"]].map(([lc,lbl]) => (
                <button key={lc} onClick={() => setLang(lc)}
                  style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #eee", cursor:"pointer", fontSize:13, fontWeight:600, background: lang===lc ? "#111" : "#fff", color: lang===lc ? "#fff" : "#666" }}>{lbl}</button>
              ))}
            </div>

            <div style={{ marginTop:20, display:"flex", alignItems:"center", gap:12 }}>
              <Btn primary disabled={savingName} onClick={saveMyName}>{savingName ? "Saving…" : "Save changes"}</Btn>
              {settingsNotice && <span style={{ fontSize:13, color: settingsNotice === "Saved." ? "#3B6D11" : "#b91c1c" }}>{settingsNotice}</span>}
              <span style={{ flex:1 }} />
              <Btn onClick={() => supabase.auth.signOut()}>Sign out</Btn>
            </div>
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:14 }}>Change password</div>

            <label style={{ fontSize:12, fontWeight:600, color:"#888", display:"block", marginBottom:6 }}>Current password</label>
            <input type="password" autoComplete="current-password" value={pwForm.current} onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))} placeholder="Current password"
              style={{ fontSize:14, padding:"9px 12px", borderRadius:8, border:"1px solid #e5e5e5", width:"100%", maxWidth:340, outline:"none", boxSizing:"border-box", marginBottom:16 }} />

            <label style={{ fontSize:12, fontWeight:600, color:"#888", display:"block", marginBottom:6 }}>New password</label>
            <input type="password" autoComplete="new-password" value={pwForm.next} onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))} placeholder="New password"
              style={{ fontSize:14, padding:"9px 12px", borderRadius:8, border:"1px solid #e5e5e5", width:"100%", maxWidth:340, outline:"none", boxSizing:"border-box", marginBottom:16 }} />

            <label style={{ fontSize:12, fontWeight:600, color:"#888", display:"block", marginBottom:6 }}>Confirm new password</label>
            <input type="password" autoComplete="new-password" value={pwForm.confirm} onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))} placeholder="Confirm new password"
              onKeyDown={e => e.key === "Enter" && !pwSaving && pwForm.current && pwForm.next && pwForm.confirm && changeMyPassword()}
              style={{ fontSize:14, padding:"9px 12px", borderRadius:8, border:"1px solid #e5e5e5", width:"100%", maxWidth:340, outline:"none", boxSizing:"border-box" }} />

            <div style={{ marginTop:20, display:"flex", alignItems:"center", gap:12 }}>
              <Btn primary disabled={pwSaving || !pwForm.current || !pwForm.next || !pwForm.confirm} onClick={changeMyPassword}>{pwSaving ? "Saving…" : "Update password"}</Btn>
              {pwNotice && <span style={{ fontSize:13, color: pwNotice.ok ? "#3B6D11" : "#b91c1c" }}>{pwNotice.text}</span>}
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────── BILLING ───────────────────────── */}
      {page === "billing" && (() => {
        const cards = billingClients.filter(c => billingTab === "all" || c.status === billingTab);
        const m = billingMetrics;
        const metricDefs = [
          { label:"Active storage clients", value: billingClients.length, color:"#185FA5" },
          { label:"Outstanding this month", value:"$"+Math.round(m.pending).toLocaleString(), color:"#A32D2D" },
          { label:"Overdue", value:`${m.overdueCount} · $${Math.round(m.overdueSum).toLocaleString()}`, color:"#A32D2D" },
          { label:"Due this week", value:`${m.weekCount} · $${Math.round(m.weekSum).toLocaleString()}`, color:"#C2410C" },
          { label:"Collected this month", value:"$"+Math.round(m.collected).toLocaleString(), color:"#1A8A4E" },
        ];
        return (
        <>
          {billingMissing && (
            <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <span>For Storage Billing, run the setup SQL once in Supabase.</span>
              <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:16 }}>
            {metricDefs.map(mt => (
              <div key={mt.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                <div style={{ fontSize:11, color:"#aaa", fontWeight:500, marginBottom:4 }}>{mt.label}</div>
                <div style={{ fontSize:20, fontWeight:700, color:mt.color }}>{mt.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
            {[["all","All"],["pending","Pending"],["overdue","Overdue"],["paid","Paid"]].map(([t,l]) => (
              <button key={t} onClick={() => setBillingTab(t)}
                style={{ fontSize:13, fontWeight: billingTab === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: billingTab === t ? "#111" : "#999", borderBottom: billingTab === t ? "2px solid #111" : "2px solid transparent" }}>{l}</button>
            ))}
          </div>

          {cards.length === 0 ? (
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"48px 24px", textAlign:"center" }}>
              <div style={{ fontSize:32, marginBottom:8 }}>🧾</div>
              <div style={{ fontSize:15, fontWeight:600, color:"#444", marginBottom:4 }}>{billingTab === "all" ? "No active storage billing clients" : `No ${billingTab} billing clients`}</div>
              {billingTab === "all" && <div style={{ marginTop:12 }}><Btn primary disabled={billingMissing} onClick={openAddBilling}>Activate billing for a job</Btn></div>}
            </div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(310px,1fr))", gap:14 }}>
              {cards.map(c => (
                <div key={c.jobKey} style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"14px 16px", display:"flex", flexDirection:"column", gap:8 }}>
                  <div style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:15, fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.customer}</div>
                      <button onClick={() => setJobDetailKey(c.jobKey)} style={{ fontFamily:"monospace", fontWeight:600, fontSize:12, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{c.job_number}</button>
                    </div>
                    <BillingBadge status={c.status} />
                  </div>
                  {/* internal view only — location is never sent to clients */}
                  <div style={{ fontSize:11.5, color:"#999" }}>📍 {c.location}{c.daysIn != null ? ` · ${c.daysIn} days in storage` : ""}</div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
                    <span style={{ fontSize:13, fontWeight:700 }}>${Number(c.rate).toLocaleString()}/mo</span>
                    {c.first_month_free && <span style={{ fontSize:9.5, fontWeight:700, color:"#3B6D11", background:"#EAF3DE", borderRadius:20, padding:"2px 8px" }}>1st month free</span>}
                  </div>
                  <div style={{ fontSize:11.5, color:"#666", borderTop:"1px solid #f3f3f3", paddingTop:8 }}>
                    <div>Billing start: <b>{c.billing_start_date || "—"}</b></div>
                    <div>Current period: <b>{c.period_start || "—"} → {c.period_end || "—"}</b></div>
                    <div style={{ marginTop:3 }}>Amount due this period: <b style={{ color: c.status === "paid" ? "#3B6D11" : c.status === "overdue" ? "#A32D2D" : "#92760B" }}>${Math.round(c.amount).toLocaleString()}</b></div>
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:"auto", paddingTop:6 }}>
                    {c.rec && c.status !== "paid"
                      ? <Btn primary onClick={() => markBillingPaid(c.rec)} style={{ padding:"5px 10px", fontSize:11.5 }}>Mark as paid</Btn>
                      : c.status === "paid" ? <span style={{ fontSize:11, color:"#3B6D11", alignSelf:"center" }}>✓ Paid{c.rec?.paid_date ? ` ${c.rec.paid_date}` : ""}</span> : null}
                    {c.status !== "paid" && <a href={billingReminderLink(c)} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn style={{ padding:"5px 10px", fontSize:11.5 }}>💬 Send reminder</Btn></a>}
                    <Btn onClick={() => openEditBillingRate(c)} style={{ padding:"5px 10px", fontSize:11.5 }}>Edit rate</Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
        );
      })()}

      {/* ───────────────────────── ANALYTICS ───────────────────────── */}
      {page === "analytics" && (
        <AnalyticsPage
          records={records} jobs={jobs} brokers={brokers} driversList={driversList}
          payments={payments} jobExtras={jobExtras} sit={sit}
          urgentPayments={urgentPayments} faddStats={faddStats}
          brokerShareMissing={brokerShareMissing} paymentsMissing={paymentsMissing}
          lang={lang}
        />
      )}

      <datalist id="drivers-list">{drivers.map(d => <option key={d} value={d} />)}</datalist>
      <datalist id="brands-list">{brands.map(b => <option key={b} value={b} />)}</datalist>
      <datalist id="states-list">{US_STATES.map(s => <option key={s} value={s} />)}</datalist>
      <datalist id="sticker-colors-list">{STICKER_COLORS.map(c => <option key={c} value={c} />)}</datalist>
      <datalist id="sizes-list">{sizes.map(s => <option key={s} value={s} />)}</datalist>

      {page === "storage" && (
        <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
          {[["storage_units","Storage Units"], ...WAREHOUSES.map(w => [w, `🏭 ${w}`])].map(([t,l]) => (
            <button key={t} onClick={() => setStorageTab(t)}
              style={{ fontSize:13, fontWeight: storageTab === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: storageTab === t ? "#111" : "#999", borderBottom: storageTab === t ? "2px solid #111" : "2px solid transparent" }}>{l}</button>
          ))}
        </div>
      )}

      {/* Nested tabs inside Storage Units */}
      {page === "storage" && storageTab === "storage_units" && (
        <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14 }}>
          {[["units","Units"],["unit_jobs","Jobs in units"]].map(([t,l]) => (
            <button key={t} onClick={() => setUnitsSubTab(t)}
              style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: unitsSubTab === t ? "#fff" : "none", color: unitsSubTab === t ? "#111" : "#888", fontWeight: unitsSubTab === t ? 600 : 400, boxShadow: unitsSubTab === t ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>{l}</button>
          ))}
        </div>
      )}

      {/* List / Map view toggle + US map (Units sub-tab) */}
      {page === "storage" && storageTab === "storage_units" && unitsSubTab === "units" && (
        <>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
            <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3 }}>
              {[["list","📋 List"],["map","🗺️ Map"]].map(([v,l]) => (
                <button key={v} onClick={() => setStorageView(v)}
                  style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: storageView === v ? "#fff" : "none", color: storageView === v ? "#111" : "#888", fontWeight: storageView === v ? 600 : 400, boxShadow: storageView === v ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>{l}</button>
              ))}
            </div>
            {mapStateFilter && (
              <span style={{ display:"inline-flex", alignItems:"center", gap:8, fontSize:12.5, background:"#EEF2FF", color:"#185FA5", borderRadius:20, padding:"5px 12px", fontWeight:600 }}>
                Filtrando: {US_CODE_TO_NAME[mapStateFilter] || mapStateFilter} ({(storageStateStats[mapStateFilter]?.count) || 0})
                <button onClick={() => setMapStateFilter("")} style={{ border:"none", background:"none", cursor:"pointer", color:"#185FA5", textDecoration:"underline", fontSize:12, padding:0 }}>Clear filter</button>
              </span>
            )}
          </div>
          {storageView === "map" && (
            Object.keys(storageStateStats).length === 0
              ? <div style={{ background:"#fff", border:"1px solid #efefef", borderRadius:12, padding:"36px", textAlign:"center", color:"#bbb", marginBottom:14 }}>No hay storages activos con estado cargado para mostrar en el mapa.</div>
              : <UsStorageMap stats={storageStateStats} selected={mapStateFilter} onSelect={setMapStateFilter} />
          )}
        </>
      )}

      {/* JOBS EN UNIDADES — active jobs stored in rented units, one row per unit */}
      {page === "storage" && storageTab === "storage_units" && unitsSubTab === "unit_jobs" && (
        <>
          <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by job #, client, driver, company, unit..."
              style={{ ...inp, flex:1, minWidth:180 }} />
          </div>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["Company","Unit","Location","Job #","Client","Volumen","Lot #","Sticker","Driver","FADD","Status",""].map((h,i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {unitJobRows.length === 0 ? (
                    <tr><td colSpan={12} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>No active jobs in rented units.</td></tr>
                  ) : unitJobRows.slice(listPage*PAGE_SIZE, (listPage+1)*PAGE_SIZE).map(j => {
                    const s = j.storage || {};
                    return (
                      <tr key={j.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", fontWeight:600 }}>{s.brand || "—"}</td>
                        <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12 }}>{s.unit || "—"}</td>
                        <td style={{ padding:"12px", fontSize:12, color:"#555" }}>{[s.address, s.state, s.zip].filter(Boolean).join(", ") || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <button onClick={() => setJobDetailKey(jobKey(j))} style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                        </td>
                        <td style={{ padding:"12px" }}>{j.customer || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{j.volume || "—"}</td>
                        <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{j.lot_number || "—"}</td>
                        <td style={{ padding:"12px" }}><Sticker color={j.sticker_color} /></td>
                        <td style={{ padding:"12px" }}>{j.driver || "—"}</td>
                        <td style={{ padding:"12px" }}><FaddBadge fadd={j.fadd} /></td>
                        <td style={{ padding:"12px" }}><StatusBadge status={j.status} /></td>
                        <td style={{ padding:"12px", textAlign:"right" }}>
                          <span onClick={() => { setJobDetailKey(null); setDetailId(j.storage_id); }} style={{ fontSize:12, color:"#185FA5", cursor:"pointer", textDecoration:"underline", whiteSpace:"nowrap" }}>Ver unidad</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa" }}>
              <Pager page={listPage} total={unitJobRows.length} unit="job(s) in units" onPage={setListPage} />
            </div>
          </div>
        </>
      )}

      {/* WAREHOUSE (owned) — one tab per warehouse: occupancy header + jobs table */}
      {page === "storage" && WAREHOUSES.includes(storageTab) && (() => {
        const name = storageTab;
        const meta = warehouseMeta[name];
        const cap = meta && meta.total_capacity_cf != null ? Number(meta.total_capacity_cf) : null;
        const used = usedCfByWarehouse[name] || 0;
        const free = cap != null ? Math.max(0, cap - used) : null;
        const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
        const inside = jobs.filter(j => jobInStorageNow(j) && j.warehouse === name);
        const byJob = []; const seen = new Set();
        for (const j of inside) { const k = jobKey(j); if (!seen.has(k)) { seen.add(k); byJob.push(j); } }
        return (
          <>
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px", marginBottom:14 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap", marginBottom:14 }}>
                <div>
                  <div style={{ fontSize:18, fontWeight:700 }}>🏭 {name}</div>
                  <div style={{ fontSize:12, color:"#999" }}>Own warehouse · {byJob.length} job(s) activo(s)</div>
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn primary disabled={!dbReady} onClick={() => openWarehouseJobPicker(name)} style={{ padding:"7px 14px" }}>+ Job a este warehouse</Btn>
                  <Btn onClick={() => openCapacity({ kind:"warehouse", name, value: cap != null ? String(cap) : "" })} style={{ padding:"7px 14px" }}>Edit capacidad</Btn>
                </div>
              </div>
              {cap != null ? (
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:6 }}>
                    <span style={{ fontWeight:700, color:occColor(pct) }}>{pct}% occupied</span>
                    <span style={{ color:"#888" }}>{Math.round(used).toLocaleString()} used · {Math.round(free).toLocaleString()} free · {cap.toLocaleString()} CF total</span>
                  </div>
                  <div style={{ background:"#f0f0f0", borderRadius:8, height:16, overflow:"hidden" }}>
                    <div style={{ background:occColor(pct), height:16, width:`${pct}%`, transition:"width .4s" }} />
                  </div>
                </div>
              ) : (
                <div style={{ fontSize:13, color:"#999", display:"flex", alignItems:"center", gap:8 }}>
                  Capacity not set · {Math.round(used).toLocaleString()} CF in use.
                  <span onClick={() => openCapacity({ kind:"warehouse", name, value:"" })} style={{ color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>Configurar capacidad</span>
                </div>
              )}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead>
                    <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                      {["Job #","Client","Lot #","Sticker","Volumen","Driver","FADD","Status",""].map((h,i) => (
                        <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {byJob.length === 0 ? (
                      <tr><td colSpan={9} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>No active jobs in this warehouse.</td></tr>
                    ) : byJob.map(j => (
                      <tr key={j.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <button onClick={() => setJobDetailKey(jobKey(j))} style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                        </td>
                        <td style={{ padding:"12px" }}>{j.customer || "—"}</td>
                        <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{j.lot_number || "—"}</td>
                        <td style={{ padding:"12px" }}><Sticker color={j.sticker_color} /></td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{j.volume || "—"}</td>
                        <td style={{ padding:"12px" }}>{j.driver || "—"}</td>
                        <td style={{ padding:"12px" }}><FaddBadge fadd={j.fadd} /></td>
                        <td style={{ padding:"12px" }}><StatusBadge status={j.status} /></td>
                        <td style={{ padding:"12px", textAlign:"right" }}>
                          <span onClick={() => setJobDetailKey(jobKey(j))} style={{ fontSize:12, color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>Ver</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{byJob.length} job(s) en {name}</div>
            </div>
          </>
        );
      })()}

      {page === "jobs" && (
        <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
          {[["active","Active"],["scheduled","Scheduled"],["in_storage","In storage"],["out_for_delivery","Out for delivery"],["delivered","Delivered"]].map(([t,l]) => {
            const n = jobTabCounts[t] || 0;
            return (
              <button key={t} onClick={() => setTab(t)} style={tabStyle(t)}>
                {l}{n > 0 && <span style={{ marginLeft:6, fontSize:11, fontWeight:600, color: tab===t?"#111":"#bbb" }}>{n}</span>}
              </button>
            );
          })}
        </div>
      )}

      {((page === "storage" && storageTab === "storage_units" && unitsSubTab === "units") || page === "jobs") && (<>
      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder={page === "storage" ? "Search company, location, zip, unit..." : "Search by job #, client, driver, zip, location..."}
          style={{ ...inp, flex:1, minWidth:180 }} />
        {page !== "storage" && (
          <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={{ ...inp, minWidth:150 }}>
            <option value="">All drivers</option>
            {drivers.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inp, minWidth:150 }}>
          <option value="date-desc">Mas reciente</option>
          <option value="date-asc">Mas antiguo</option>
          <option value="customer">Client A-Z</option>
          <option value="driver">Driver A-Z</option>
        </select>
      </div>

      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          {page === "storage" ? (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13, tableLayout:"fixed" }}>
              <colgroup>
                <col style={{width:120}}/><col style={{width:55}}/><col style={{width:70}}/><col style={{width:150}}/>
                <col style={{width:65}}/><col style={{width:110}}/><col style={{width:100}}/><col style={{width:85}}/><col style={{width:75}}/><col style={{width:80}}/><col style={{width:140}}/>
              </colgroup>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Company","Status","Zip","Address","Unit","Gate Code","Apertura","Payment","Jobs activos","Situacion","Occupancy"].map(h => (
                    <th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unitRows.length === 0 ? (
                  <tr><td colSpan={11} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin unidades</td></tr>
                ) : unitRows.slice(listPage*PAGE_SIZE, (listPage+1)*PAGE_SIZE).map(r => {
                  const n = activeJobsByStorage[r.id] || 0;
                  const cap = r.total_capacity_cf != null ? Number(r.total_capacity_cf) : null;
                  const used = usedCfByStorage[r.id] || 0;
                  return (
                    <tr key={r.id} onClick={() => setDetailId(r.id)}
                      style={{ borderBottom:"1px solid #fafafa", cursor:"pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background="#fafafa"}
                      onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                      <td style={{ padding:"10px 12px", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.brand||"—"}</td>
                      <td style={{ padding:"10px 12px" }}>{r.state||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>{r.zip||"—"}</td>
                      <td style={{ padding:"10px 12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.address||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>{r.unit||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:11 }}>
                        <span style={{ display:"inline-flex", alignItems:"center", maxWidth:"100%" }}>
                          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.gate_code||"—"}</span>
                          {r.gate_code && <CopyButton value={r.gate_code} />}
                        </span>
                      </td>
                      <td style={{ padding:"10px 12px", fontSize:12, color:"#555", whiteSpace:"nowrap" }}>{r.date_opened||"—"}</td>
                      <td style={{ padding:"10px 12px" }}><PaymentBadge record={r} situation={sit(r)} /></td>
                      <td style={{ padding:"10px 12px" }}>
                        <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: n>0?"#EAF3DE":"#f5f5f5", color: n>0?"#3B6D11":"#bbb" }}>{n}</span>
                      </td>
                      <td style={{ padding:"10px 12px" }}><Badge situation={sit(r)} /></td>
                      <td style={{ padding:"10px 12px" }} onClick={e => e.stopPropagation()}>
                        {cap != null ? <OccupancyBar used={used} total={cap} />
                          : <Btn onClick={() => openCapacity({ kind:"unit", id:r.id, value:"" })} style={{ padding:"4px 9px", fontSize:11 }}>Set capacity</Btn>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Job #","Client","Type","Status","FADD","Volumen","Location","Driver","Ruta", tab==="delivered"?"Delivered":""].filter(Boolean).map(h => (
                    <th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                  <th style={{ width:150 }} />
                </tr>
              </thead>
              <tbody>
                {jobGroups.length === 0 ? (
                  <tr><td colSpan={12} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{tab==="delivered" ? "No delivered jobs" : tab==="active" ? "No active jobs. Add one with \"+ New job\"." : "No jobs in this status."}</td></tr>
                ) : jobGroups.slice(listPage*PAGE_SIZE, (listPage+1)*PAGE_SIZE).map(g => {
                  // Where the goods currently sit: warehouse name, or storage brand + state.
                  const locs = [...new Set(g.parts.map(p => p.warehouse ? `Warehouse ${p.warehouse}` : [p.storage?.brand, p.storage?.state].filter(Boolean).join(" · ")).filter(Boolean))];
                  const mapHref = routeUrl(g);
                  return (
                  <tr key={g.key} style={{ borderBottom:"1px solid #fafafa", verticalAlign:"top" }}>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      <button onClick={() => setJobDetailKey(g.key)}
                        style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>
                        {g.job_number || "(ver)"}
                      </button>
                    </td>
                    <td style={{ padding:"12px" }}>{g.customer||"—"}</td>
                    <td style={{ padding:"12px" }}><TypeBadge type={g.job_type} /></td>
                    <td style={{ padding:"12px" }}><StatusBadge status={g.status} /></td>
                    <td style={{ padding:"12px" }}><FaddBadge fadd={g.fadd} /></td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{g.volume||"—"}</td>
                    <td style={{ padding:"12px", fontSize:12, color:"#555" }}>
                      {locs.length ? locs.map((a, i) => <div key={i} style={{ marginBottom: i < locs.length-1 ? 3 : 0 }}>{a}</div>) : "—"}
                    </td>
                    <td style={{ padding:"12px" }}>{g.driver||"—"}</td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      {mapHref ? <a href={mapHref} target="_blank" rel="noreferrer" style={{ color:"#185FA5", textDecoration:"none", fontSize:13 }}>🗺️ Ruta</a> : "—"}
                    </td>
                    {tab === "delivered" ? (
                      <>
                        <td style={{ padding:"12px", fontSize:12, color:"#888", whiteSpace:"nowrap" }}>{g.parts.map(p => p.date_out).filter(Boolean)[0] || "—"}</td>
                        <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                          <Btn onClick={() => undeliverJobs(g.parts.map(p => p.id))} style={{ padding:"5px 10px", fontSize:12 }}>Desentregar</Btn>
                          <button onClick={() => deleteJob(g)} title="Delete job" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:15, marginLeft:6, verticalAlign:"middle" }}>🗑</button>
                        </td>
                      </>
                    ) : (
                      <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                        <Btn onClick={() => deliverJobs(g.parts.map(p => p.id))} style={{ padding:"5px 10px", fontSize:12 }}>Mark delivered</Btn>
                        <button onClick={() => deleteJob(g)} title="Delete job" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:15, marginLeft:6, verticalAlign:"middle" }}>🗑</button>
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa" }}>
          <Pager page={listPage} total={page === "storage" ? unitRows.length : jobGroups.length}
            unit={page === "storage" ? "units" : "job(s)"} onPage={setListPage} />
        </div>
      </div>
      </>)}

      </div>{/* end page content */}

      {jobDetail && (
        <Modal title={`Job ${jobDetail.job_number || ""}`.trim()} onClose={() => setJobDetailKey(null)}
          footer={<>
            <Btn onClick={() => openEditJob(jobDetail)}>Edit</Btn>
            {can("bol","view") && <Btn primary onClick={() => { const jn = jobDetail.job_number; setJobDetailKey(null); setBolJobNumber(jn || ""); setPage("bol"); }}>📄 Generate BOL</Btn>}
            <Btn danger onClick={() => deleteJob(jobDetail)}>🗑 Delete job</Btn>
            <Btn onClick={() => window.open(waLink(jobDetail, (jobDetail.parts||[]).map(p => p.warehouse ? `Warehouse ${p.warehouse}` : [p.storage?.brand, p.storage?.unit && "U"+p.storage.unit, p.storage?.state].filter(Boolean).join(" ")).filter(Boolean).join(" · "), brokerName(jobDetail.broker_id), jobGroupLink(jobDetail)), "_blank")}>💬 WhatsApp</Btn>
            {nextStatus(jobDetail) && <Btn onClick={() => advanceStatus(jobDetail)}>→ {statusMeta(nextStatus(jobDetail)).l}</Btn>}
            {jobDetail.parts.some(p => !p.date_out) && (
              <Btn onClick={() => deliverJobs(jobDetail.parts.filter(p => !p.date_out).map(p => p.id))}>Mark all delivered</Btn>
            )}
            {jobDetail.parts.some(p => p.date_out) && (
              <Btn onClick={() => undeliverJobs(jobDetail.parts.filter(p => p.date_out).map(p => p.id))}>Desentregar todo</Btn>
            )}
            {!jobSplitColMissing && jobDetail.parts.some(p => p.split_group) && (
              <Btn disabled={tripBusy} onClick={() => mergeSplit(jobDetail.parts.find(p => p.split_group))}>✂️ {trAI("Merge portions", "Unir porciones")}</Btn>
            )}
            <Btn primary onClick={() => setJobDetailKey(null)}>Close</Btn>
          </>}>
          {/* Calendar / pickup-date block (Add to calendar + Edit pickup date) */}
          {(() => {
            const ids = jobDetail.parts.map(p => p.id);
            const from = jobDetail.pickup_date_from || jobDetail.pickup_date || "";
            const to = jobDetail.pickup_date_to || "";
            const onCal = !!from;
            return (
              <div style={{ background: onCal ? "#EAF3DE" : "#F5F7FA", border:`1px solid ${onCal ? "#cfe3b3" : "#e3e8ef"}`, borderRadius:10, padding:"10px 12px", marginBottom:12 }}>
                {!pickupEditor ? (
                  <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                    <span style={{ fontSize:12.5, color: onCal ? "#3B6D11" : "#667", flex:1 }}>
                      {onCal
                        ? <>📅 On calendar: <b>{from}</b>{to && to !== from ? <> → <b>{to}</b></> : null}</>
                        : <>📅 Not on the calendar yet — this job has no pickup date.</>}
                    </span>
                    {onCal
                      ? <Btn style={{ padding:"5px 11px", fontSize:12 }} onClick={() => setPickupEditor({ from, to })}>Edit pickup date</Btn>
                      : <Btn primary style={{ padding:"5px 11px", fontSize:12 }} onClick={() => setPickupEditor({ from:"", to:"" })}>Add to calendar</Btn>}
                  </div>
                ) : (
                  <div style={{ display:"flex", alignItems:"flex-end", gap:10, flexWrap:"wrap" }}>
                    <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                      <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Pickup date from</label>
                      <input style={inp} type="date" value={pickupEditor.from} onChange={e => setPickupEditor(p => ({ ...p, from:e.target.value }))} />
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                      <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Pickup date to (optional)</label>
                      <input style={inp} type="date" value={pickupEditor.to} onChange={e => setPickupEditor(p => ({ ...p, to:e.target.value }))} />
                    </div>
                    <Btn primary style={{ padding:"7px 12px", fontSize:12 }} disabled={!pickupEditor.from}
                      onClick={async () => { await setJobPickup(ids, pickupEditor.from, pickupEditor.to); setPickupEditor(null); showToast("Pickup date saved"); }}>Save</Btn>
                    {onCal && <Btn danger style={{ padding:"7px 12px", fontSize:12 }}
                      onClick={async () => { await setJobPickup(ids, "", ""); setPickupEditor(null); showToast("Removed from calendar"); }}>Remove from calendar</Btn>}
                    <Btn style={{ padding:"7px 12px", fontSize:12 }} onClick={() => setPickupEditor(null)}>Cancel</Btn>
                  </div>
                )}
              </div>
            );
          })()}
          <SectionLabel>Job data <span style={{ textTransform:"none", letterSpacing:0, fontWeight:400, color:"#bbb" }}>· click to edit</span></SectionLabel>
          {(() => { const P = jobDetail.parts; const set = (f) => (v) => updateJobField(P, f, v); return (
          <>
          <EditRow label="Job #"><InlineField mono value={jobDetail.job_number} onSave={set("job_number")} /></EditRow>
          <EditRow label="Client"><InlineField value={jobDetail.customer} onSave={set("customer")} /></EditRow>
          <EditRow label="Broker">
            <select value={jobDetail.broker_id || ""} onChange={e => set("broker_id")(e.target.value ? Number(e.target.value) : "")}
              style={{ fontSize:13, padding:"4px 8px", borderRadius:8, border:"1px solid #e5e5e5", outline:"none", background:"#fff" }}>
              <option value="">— Sin broker —</option>
              {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </EditRow>
          <EditRow label="Type"><TypeBadge type={jobDetail.job_type} /></EditRow>
          <EditRow label="Status"><span style={{ display:"inline-flex", alignItems:"center", gap:8 }}><StatusBadge status={jobDetail.status} />{nextStatus(jobDetail) && <button onClick={() => advanceStatus(jobDetail)} style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:7, border:"1px solid #e5e5e5", background:"#fff", cursor:"pointer" }}>→ {statusMeta(nextStatus(jobDetail)).l}</button>}</span></EditRow>
          <EditRow label="Calendar status (color)">
            {(() => { const cur = calStatusOf(jobDetail); const cm = calStatusMeta(cur) || CALENDAR_STATUSES[0]; return (
              <span style={{ display:"inline-flex", alignItems:"center", gap:8 }}>
                <span title="Calendar color" style={{ width:14, height:14, borderRadius:4, background:cm.bar, border:"1px solid rgba(0,0,0,0.1)", flexShrink:0 }} />
                <select value={cur} disabled={calStatusMissing} onChange={e => updateJobField(P, "calendar_status", e.target.value)}
                  style={{ fontSize:13, padding:"4px 8px", borderRadius:8, border:"1px solid #e5e5e5", outline:"none", background:"#fff" }}>
                  {CALENDAR_STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                </select>
              </span>
            ); })()}
          </EditRow>
          <EditRow label="Driver (who dropped it off)"><InlineField listId="drivers-list" value={jobDetail.driver} onSave={set("driver")} /></EditRow>
          <EditRow label="Volumen (CF) — estimado"><InlineField value={jobDetail.volume} onSave={set("volume")} /></EditRow>
          {!realCfMissing && (
            <EditRow label="Real CF (medido)">
              <InlineField type="number" value={jobDetail.real_cf ?? ""} onSave={set("real_cf")}
                display={hasRealCf(jobDetail)
                  ? <span style={{ fontWeight:600, color:"#3B6D11" }}>{Math.round(Number(jobDetail.real_cf)).toLocaleString()} CF ✓{parseCf(jobDetail.volume) > 0 ? <span style={{ fontWeight:400, color:"#999" }}> · est. {Math.round(parseCf(jobDetail.volume)).toLocaleString()}</span> : null}</span>
                  : <span style={{ color:"#bbb" }}>— (usa el estimado)</span>} />
            </EditRow>
          )}
          <EditRow label="Lot number (sticker)"><InlineField mono value={jobDetail.lot_number} onSave={set("lot_number")} /></EditRow>
          <EditRow label="Sticker color"><InlineField type="text" listId="sticker-colors-list" value={jobDetail.sticker_color} onSave={set("sticker_color")} display={jobDetail.sticker_color ? <Sticker color={jobDetail.sticker_color} /> : null} /></EditRow>
          <EditRow label="FADD"><InlineField type="date" value={jobDetail.fadd} onSave={set("fadd")} display={<FaddBadge fadd={jobDetail.fadd} />} /></EditRow>
          <EditRow label="Pick up from"><InlineField type="date" value={jobDetail.pickup_date_from || jobDetail.pickup_date} onSave={(v) => { updateJobField(P, "pickup_date_from", v); updateJobField(P, "pickup_date", v); }} /></EditRow>
          <EditRow label="Pick up to (opcional)"><InlineField type="date" value={jobDetail.pickup_date_to} onSave={set("pickup_date_to")} /></EditRow>
          <EditRow label="Pickup address"><InlineField value={jobDetail.pickup_address} onSave={set("pickup_address")} /></EditRow>
          <EditRow label="Pickup city"><InlineField value={jobDetail.pickup_city} onSave={set("pickup_city")} /></EditRow>
          <EditRow label="Pickup state"><InlineField listId="states-list" transform={v => v.toUpperCase()} value={jobDetail.pickup_state} onSave={set("pickup_state")} /></EditRow>
          <EditRow label="Pickup zip"><InlineField value={jobDetail.pickup_zip} onSave={set("pickup_zip")} /></EditRow>
          <EditRow label="Balance pickup ($)"><InlineField value={jobDetail.pickup_balance} onSave={set("pickup_balance")} display={money(jobDetail.pickup_balance)} /></EditRow>
          <EditRow label="Date in (a storage)"><InlineField type="date" value={jobDetail.date_in} onSave={set("date_in")} /></EditRow>
          <EditRow label="Delivery date"><InlineField type="date" value={jobDetail.delivery_date} onSave={set("delivery_date")} /></EditRow>
          <EditRow label="Delivery address"><InlineField value={jobDetail.delivery_address} onSave={set("delivery_address")} /></EditRow>
          <EditRow label="Delivery city"><InlineField value={jobDetail.delivery_city} onSave={set("delivery_city")} /></EditRow>
          <EditRow label="Delivery state"><InlineField listId="states-list" transform={v => v.toUpperCase()} value={jobDetail.delivery_state} onSave={set("delivery_state")} /></EditRow>
          <EditRow label="Delivery zip"><InlineField value={jobDetail.delivery_zip} onSave={set("delivery_zip")} /></EditRow>
          <EditRow label="Balance delivery ($)"><InlineField value={jobDetail.delivery_balance} onSave={set("delivery_balance")} display={money(jobDetail.delivery_balance)} /></EditRow>
          {routeUrl(jobDetail) && (
            <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}>
              <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>Ruta</span>
              <a href={routeUrl(jobDetail)} target="_blank" rel="noreferrer" style={{ fontWeight:500, color:"#185FA5", textDecoration:"none" }}>🗺️ View route storage → delivery en Google Maps</a>
            </div>
          )}
          <EditRow label="Client billing">
            {jobDetail.billing_active
              ? <span style={{ color:"#3B6D11", fontWeight:600 }}>Active · {money(jobDetail.client_monthly_rate) || "$0"}/mo{jobDetail.first_month_free ? " · 1st month free" : ""}{jobDetail.billing_start_date ? ` · since ${jobDetail.billing_start_date}` : ""}</span>
              : <span style={{ color:"#bbb" }}>No se cobra storage</span>}
          </EditRow>
          <EditRow label="Notes"><InlineField value={jobDetail.notes} onSave={set("notes")} /></EditRow>
          </>
          ); })()}

          {!settlementsMissing && (
            <>
              <SectionLabel>Carrier Settlement</SectionLabel>
              {(() => {
                const linkedId = jobDetail.closing_sheet_id;
                const linked = linkedId ? closingSheets.find(s => s.id === Number(linkedId)) : null;
                const openSheets = closingSheets.filter(s => s.status === "open");
                const selStyle = { fontSize:12, padding:"4px 8px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff" };
                const onMove = (v) => {
                  if (!v) return;
                  if (v === "__unlink") updateJobBol(jobDetail.key, "closing_sheet_id", "");
                  else if (v === "__new") addJobToNewSheet(jobDetail.key, jobDetail.broker_id);
                  else updateJobBol(jobDetail.key, "closing_sheet_id", Number(v));
                };
                return (
                  <EditRow label="Closing sheet">
                    {linked ? (
                      <span style={{ display:"inline-flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                        <button onClick={() => { setJobDetailKey(null); setPage("settlements"); setCsDetailId(linked.id); }} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>#{linked.closing_sheet_number || linked.id}</button>
                        <CSBadge status={linked.status} />
                        <select value="" onChange={e => onMove(e.target.value)} style={selStyle}>
                          <option value="">Move…</option>
                          {openSheets.filter(s => s.id !== linked.id).map(s => <option key={s.id} value={String(s.id)}>→ #{s.closing_sheet_number || s.id}</option>)}
                          <option value="__new">→ ➕ New</option>
                          <option value="__unlink">Remove from closing sheet</option>
                        </select>
                      </span>
                    ) : (
                      <select value="" onChange={e => onMove(e.target.value)} style={selStyle}>
                        <option value="">+ Add to closing sheet…</option>
                        {openSheets.map(s => <option key={s.id} value={String(s.id)}>#{s.closing_sheet_number || s.id} · {brokerName(s.broker_id) || "no broker"}</option>)}
                        <option value="__new">➕ Create new</option>
                      </select>
                    )}
                  </EditRow>
                );
              })()}
              {(() => { const P = jobDetail.parts; return (<>
                <EditRow label="Carrier rate / CF"><InlineField value={jobDetail.carrier_rate_per_cf} onSave={(v) => updateJobField(P, "carrier_rate_per_cf", v === "" ? null : Number(v))} display={money(jobDetail.carrier_rate_per_cf)} /></EditRow>
                <EditRow label="Carrier fee (auto)"><span style={{ fontWeight:600 }}>{money(parseCf(jobDetail.volume) * numv(jobDetail.carrier_rate_per_cf)) || "$0"}</span></EditRow>
                <EditRow label="BOL balance to collect"><InlineField value={jobDetail.bol_balance} onSave={(v) => updateJobField(P, "bol_balance", v === "" ? null : Number(v))} display={money(jobDetail.bol_balance)} /></EditRow>
                <EditRow label="BOL collected">
                  <span style={{ display:"inline-flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontWeight:600, color:"#1A8A4E" }}>{money(jobDetail.bol_collected) || "$0"}</span>
                    {(() => { const cs = collectionStatus(jobDetail); return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background:cs.bg, color:cs.text }}><span style={{ width:6, height:6, borderRadius:"50%", background:cs.dot }} />{cs.l}</span>; })()}
                    <Btn onClick={() => setPayModal({ jobKey:jobDetail.key, amount: jobDetail.bol_collected ?? "", method: jobDetail.bol_payment_method || "", date: jobDetail.bol_collected_date || today(), notes:"", entries:[{ method:"cash", amount:"" }] })} style={{ padding:"3px 9px", fontSize:11 }}>Record payment</Btn>
                  </span>
                </EditRow>
              </>); })()}
            </>
          )}

          {!extrasMissing && (() => {
            const exs = (extrasByJobKey[jobDetail.key] || []).filter(e => e.active !== false);
            const repId = Math.min(...jobDetail.parts.map(p => p.id));
            const firstDriver = Array.isArray(jobDetail.driver_ids) && jobDetail.driver_ids.length ? jobDetail.driver_ids[0] : "";
            const totAmt = exs.reduce((s, e) => s + numv(e.amount), 0);
            // Per-extra paid/pending chips (payments allocated via job_extra_id + legacy link).
            const chargeState = paymentsMissing ? null : chargeStateByJobKey(jobDetail.key);
            const chargeOf = (e) => chargeState?.extraCharges.find(c => Number(c.extra.id) === Number(e.id));
            return (
              <>
                <SectionLabel>Extras {exs.length ? `(${exs.length})` : ""}</SectionLabel>
                {exs.length === 0
                  ? <div style={{ fontSize:13, color:"#bbb", padding:"4px 0" }}>Sin extras en este job.</div>
                  : exs.map(e => (
                      <div key={e.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13, flexWrap:"wrap" }}>
                        <span style={{ fontWeight:600 }}>{extraTypeLabel(e.extra_type)}{e.extra_type === "other" && e.description ? ` · ${e.description}` : ""}</span>
                        <span style={{ color:"#111", fontWeight:600 }}>{money(e.amount) || "$0"}</span>
                        {(() => {
                          const c = chargeOf(e);
                          if (!c) return null;
                          return c.remaining > 0.01
                            ? <span style={{ fontSize:10.5, fontWeight:700, color:"#92760B", background:"#FEF3C7", borderRadius:20, padding:"1px 8px" }}>Pendiente ${Math.round(c.remaining).toLocaleString()}</span>
                            : <span style={{ fontSize:10.5, fontWeight:700, color:"#3B6D11", background:"#EAF3DE", borderRadius:20, padding:"1px 8px" }}>Pagado</span>;
                        })()}
                        <span style={{ fontSize:11, color:"#888" }}>{genByLabel(e.generated_by)}</span>
                        {driverById[e.driver_id]?.name && <span style={{ fontSize:11, color:"#888" }}>🧑‍✈️ {driverById[e.driver_id].name}</span>}
                        {empById[e.rep_id]?.name && <span style={{ fontSize:11, color:"#888" }}>👤 {empById[e.rep_id].name}</span>}
                        <span style={{ flex:1 }} />
                        <span style={{ fontSize:12, color:"#1A8A4E", fontWeight:600 }}>D {money(e.driver_commission_amount) || "$0"}</span>
                        <span style={{ fontSize:12, color:"#185FA5", fontWeight:600 }}>R {money(e.rep_commission_amount) || "$0"}</span>
                        <button onClick={() => deleteExtra(e)} title="Delete" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:16, lineHeight:1 }}>×</button>
                      </div>
                    ))}
                <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:8 }}>
                  {exs.length > 0 && <span style={{ fontSize:13, color:"#666" }}>Total extras: <b>${Math.round(totAmt).toLocaleString()}</b></span>}
                  <span style={{ flex:1 }} />
                  <Btn onClick={() => setQuickExtra({ jobId: repId, extra_type:"extra_cf", description:"", amount:"", generated_by:"driver_only", driver_id: firstDriver, rep_id:"", driver_commission_pct:10, rep_commission_pct:0, notes:"", extra_cf_count:"", extra_cf_rate:"", fuel_surcharge_pct: jobDetail.fuel_surcharge_pct ?? "", commission_base:"with_fuel", broker_share_pct:"", broker_share_enabled:false })} style={{ padding:"5px 12px", fontSize:12 }}>+ Add extra</Btn>
                </div>
              </>
            );
          })()}

          {!paymentsMissing && (() => {
            const ps = (paymentsByJobKey[jobDetail.key] || []).slice().sort((a, b) => (b.payment_date || "").localeCompare(a.payment_date || ""));
            const recv = ps.filter(p => p.received);
            // Job balance and extras are tracked independently — never mixed.
            const expected = numv(jobDetail.pickup_balance) + numv(jobDetail.delivery_balance) + numv(jobDetail.bol_balance);
            const jobCollected = recv.filter(p => p.concept === "job").reduce((s, p) => s + paymentNet(p), 0);
            const jobOutstanding = Math.max(0, expected - jobCollected);
            const extraPays = recv.filter(p => p.concept === "extra");
            const extrasCollected = extraPays.reduce((s, p) => s + paymentNet(p), 0);
            const ccFeeTotal = recv.filter(p => p.concept === "cc_fee").reduce((s, p) => s + paymentNet(p), 0);
            // Extras owed (from job_extras) vs collected (extra-concept payments).
            const exsOwed = (extrasByJobKey[jobDetail.key] || []).filter(e => e.active !== false).reduce((s, e) => s + numv(e.amount), 0);
            const extrasOutstanding = Math.max(0, exsOwed - extrasCollected);
            const totalOutstanding = jobOutstanding + extrasOutstanding;
            // Per-extra-type breakdown of what was collected via payments.
            const byType = {};
            for (const p of extraPays) { const t = p.extra_type || "extra"; byType[t] = (byType[t] || 0) + paymentNet(p); }
            const typeEntries = Object.entries(byType);
            // Broker share deductions (job balance + extras) → net revenue to the company.
            const jobBrokerSharePct = numv(jobDetail.broker_job_share_pct);
            const jobBrokerShare = jobCollected * jobBrokerSharePct / 100;
            const extrasBrokerShare = (extrasByJobKey[jobDetail.key] || []).filter(e => e.active !== false).reduce((s, e) => s + extraBrokerShare(e), 0);
            const totalBrokerShare = jobBrokerShare + extrasBrokerShare;
            const netRevenue = (jobCollected + extrasCollected) - totalBrokerShare;
            const repId = Math.min(...jobDetail.parts.map(p => p.id));
            const firstDriverName = (Array.isArray(jobDetail.driver_ids) && jobDetail.driver_ids.length ? driverById[jobDetail.driver_ids[0]]?.name : "") || "";
            return (
              <>
                <SectionLabel>Payments {ps.length ? `(${ps.length})` : ""}</SectionLabel>
                <div style={{ background:"#fafafa", borderRadius:9, padding:"10px 12px", marginBottom:8 }}>
                  <div style={{ display:"flex", gap:16, flexWrap:"wrap", fontSize:13 }}>
                    <span>Balance del job: <b>${Math.round(expected).toLocaleString()}</b></span>
                    <span>Cobrado (job): <b style={{ color:"#1A8A4E" }}>${Math.round(jobCollected).toLocaleString()}</b></span>
                    <span>Job balance: <b style={{ color: jobOutstanding > 0 ? "#E24B4A" : "#1A8A4E" }}>${Math.round(jobOutstanding).toLocaleString()}</b></span>
                  </div>
                  {(exsOwed > 0 || extrasCollected > 0) && (
                    <div style={{ display:"flex", gap:16, flexWrap:"wrap", fontSize:12.5, marginTop:6, paddingTop:6, borderTop:"1px solid #eee", color:"#555" }}>
                      <span>Extras cobrados: <b style={{ color:"#6D28D9" }}>${Math.round(extrasCollected).toLocaleString()}</b></span>
                      {exsOwed > 0 && <span>Extras facturados: <b>${Math.round(exsOwed).toLocaleString()}</b></span>}
                      {extrasOutstanding > 0 && <span>Extras pendientes: <b style={{ color:"#EF9F27" }}>${Math.round(extrasOutstanding).toLocaleString()}</b></span>}
                    </div>
                  )}
                  {typeEntries.length > 0 && (
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:6 }}>
                      {typeEntries.map(([t, amt]) => <span key={t} style={{ fontSize:10.5, fontWeight:600, color:"#6D28D9", background:"#EDE9FE", borderRadius:20, padding:"2px 9px" }}>{extraTypeLabel(t)} ${Math.round(amt).toLocaleString()}</span>)}
                    </div>
                  )}
                  {ccFeeTotal > 0 && <div style={{ fontSize:12, marginTop:6, color:"#854F0B" }}>CC fees cobrados: <b>${Math.round(ccFeeTotal).toLocaleString()}</b></div>}
                  {(() => {
                    // Money received but not yet applied to a charge ("a cuenta").
                    const onAcc = recv.filter(p => p.concept === "on_account");
                    const onAccSum = onAcc.reduce((s, p) => s + paymentNet(p), 0);
                    if (onAccSum <= 0) return null;
                    const first = onAcc.find(p => p.job_id && !allocMissing);
                    return (
                      <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:12.5, marginTop:6, color:"#854F0B" }}>
                        <span>A cuenta (sin imputar): <b>${Math.round(onAccSum).toLocaleString()}</b></span>
                        {first && can("payments","edit") && <button onClick={() => openReallocatePayment(first)} style={{ border:"1px solid #F4DDB0", background:"#FFF6E8", color:"#854F0B", fontSize:11, fontWeight:700, borderRadius:6, padding:"1px 8px", cursor:"pointer" }}>Asignar</button>}
                      </div>
                    );
                  })()}
                  {(() => {
                    const un = paymentsMissing ? 0 : chargeStateByJobKey(jobDetail.key).unattributedExtraCollected;
                    return un > 0.01 ? <div style={{ fontSize:11, marginTop:4, color:"#999" }}>${Math.round(un).toLocaleString()} cobrados de extras sin asignar a un extra específico (histórico).</div> : null;
                  })()}
                  {totalBrokerShare > 0 && (
                    <div style={{ marginTop:6, paddingTop:6, borderTop:"1px solid #eee", fontSize:12.5 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", color:"#C2410C" }}>
                        <span>− Broker share{jobBrokerSharePct > 0 ? ` (job ${jobBrokerSharePct}%)` : ""}</span>
                        <span><b>−${Math.round(totalBrokerShare).toLocaleString()}</b></span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", marginTop:3, fontWeight:700 }}>
                        <span>Net revenue (post broker)</span>
                        <span style={{ color:"#1A8A4E" }}>${Math.round(netRevenue).toLocaleString()}</span>
                      </div>
                    </div>
                  )}
                  <div style={{ display:"flex", justifyContent:"space-between", marginTop:8, paddingTop:8, borderTop:"1px solid #eee", fontSize:13.5, fontWeight:800 }}>
                    <span>Total outstanding balance</span>
                    <span style={{ color: totalOutstanding > 0 ? "#E24B4A" : "#1A8A4E" }}>${Math.round(totalOutstanding).toLocaleString()}</span>
                  </div>
                </div>
                {ps.length === 0 ? <div style={{ fontSize:13, color:"#bbb", padding:"4px 0" }}>Sin pagos registrados.</div>
                  : ps.map(p => (
                      <div key={p.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13, flexWrap:"wrap" }}>
                        <ConceptBadge concept={p.concept} />
                        {p.concept === "extra" && p.extra_type && <span style={{ fontSize:10.5, color:"#6D28D9", fontWeight:600 }}>{extraTypeLabel(p.extra_type)}</span>}
                        {p.split_group && <span title="Part of a split payment" style={{ fontSize:9, fontWeight:700, color:"#6D28D9", background:"#EDE9FE", borderRadius:20, padding:"1px 6px" }}>split</span>}
                        <PaymentMethodBadge method={p.method} />
                        <b>{money(paymentNet(p)) || "$0"}</b>
                        <span style={{ fontSize:11, color:"#888" }}>{p.payment_date || "—"}</span>
                        {p.received
                          ? (p.banked
                              ? <span style={{ fontSize:10.5, fontWeight:700, color:"#185FA5", background:"#E6F1FB", borderRadius:20, padding:"1px 7px" }}>Deposited</span>
                              : <span style={{ fontSize:10.5, fontWeight:700, color:"#C2410C", background:"#FDE3CF", borderRadius:20, padding:"1px 7px" }}>In circulation{p.cash_with_whom ? ` · ${p.cash_with_whom}` : ""}</span>)
                          : <span style={{ fontSize:10.5, fontWeight:700, color:"#999", background:"#F1F1F1", borderRadius:20, padding:"1px 7px" }}>Pending</span>}
                        <span style={{ flex:1 }} />
                        <button onClick={() => openEditPayment(p)} title="Edit" style={{ border:"none", background:"none", cursor:"pointer", color:"#185FA5", fontSize:12 }}>✏️</button>
                      </div>
                    ))}
                <div style={{ display:"flex", justifyContent:"flex-end", marginTop:8 }}>
                  <Btn onClick={() => openAddPayment({ job_id: repId, received_by: firstDriverName, cash_with_whom: firstDriverName, amount: jobOutstanding > 0 ? String(Math.round(jobOutstanding)) : "" })} style={{ padding:"5px 12px", fontSize:12 }}>+ Add pago</Btn>
                </div>
              </>
            );
          })()}

          {(() => {
            const partIds = jobDetail.parts.map(p => p.id);
            const partSet = new Set(partIds);
            const repId = Math.min(...partIds);
            const storageTargets = [
              ...records.filter(r => r.space_type !== "warehouse").map(r => ({ key:String(r.id), id:r.id, label:[r.brand, r.unit && "U"+r.unit, r.state].filter(Boolean).join(" ") || `Unit #${r.id}` })),
              ...WAREHOUSES.map(w => ({ key:"wh:"+w, id:null, label:`Warehouse ${w}` })),
            ];
            // Merge automatic trip_events + manual job_events for this job, oldest → newest.
            const items = [];
            if (!tripEventsMissing) for (const e of tripEvents) {
              if (!partSet.has(e.job_id)) continue;
              const m = TRIP_EVENT_META[e.event_type] || { l:e.event_type, icon:"•" };
              items.push({ id:"t"+e.id, source:"trip", icon:m.icon, label:m.l, date:e.created_at, sort:(e.created_at || "").slice(0,10)+"|"+(e.created_at || ""), notes:e.notes, by:e.created_by, tripBadge: e.trip_id ? (tripById[e.trip_id]?.trip_number || "#"+e.trip_id) : null, storageBadge: e.storage_id ? (storageById[e.storage_id]?.brand || "storage") : null });
            }
            if (!jobEventsMissing) for (const e of jobEvents) {
              if (!partSet.has(e.job_id)) continue;
              const m = jobEventMeta(e.event_type);
              items.push({ id:"j"+e.id, source:"manual", raw:e, icon:m.icon, label:m.l, date:e.event_date || e.created_at, sort:(e.event_date || (e.created_at || "").slice(0,10))+"|"+(e.created_at || ""), notes:e.notes, by:e.created_by, tripBadge: e.trip_ref || null, storageBadge: e.storage_label || (e.storage_id ? (storageById[e.storage_id]?.brand || "storage") : null) });
            }
            items.sort((a, b) => a.sort.localeCompare(b.sort));
            const setJE = (fields) => setJobEventForm(f => ({ ...f, ...fields }));
            const meta = jobEventForm ? jobEventMeta(jobEventForm.event_type) : null;
            return (
              <>
                <SectionLabel>Timeline {items.length ? `(${items.length})` : ""}</SectionLabel>
                {jobEventsMissing && (
                  <div style={{ fontSize:11.5, color:"#854F0B", background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:8, padding:"6px 10px", marginBottom:8 }}>
                    Run the updated SQL to save manual job events. <button onClick={() => setShowSetup(true)} style={{ border:"none", background:"none", color:"#854F0B", textDecoration:"underline", cursor:"pointer", fontSize:11.5 }}>View SQL</button>
                  </div>
                )}
                {items.length === 0 && !jobEventForm ? <div style={{ fontSize:13, color:"#bbb", padding:"4px 0" }}>No events yet.</div>
                  : <div style={{ display:"flex", flexDirection:"column" }}>
                      {items.map((it, i) => (
                        <div key={it.id} style={{ display:"flex", gap:10, padding:"8px 0", borderBottom: i < items.length-1 ? "1px solid #f4f4f4" : "none" }}>
                          <div style={{ fontSize:16, lineHeight:1.2 }}>{it.icon}</div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                              <b style={{ fontSize:13 }}>{it.label}</b>
                              {it.source === "trip" && <span style={{ fontSize:9.5, fontWeight:700, color:"#6D28D9", background:"#EDE9FE", borderRadius:20, padding:"1px 7px" }}>auto</span>}
                              {it.tripBadge && <span style={{ fontSize:9.5, fontWeight:700, color:"#185FA5", background:"#E6F1FB", borderRadius:20, padding:"1px 7px", fontFamily:"monospace" }}>🛣️ {it.tripBadge}</span>}
                              {it.storageBadge && <span style={{ fontSize:9.5, fontWeight:700, color:"#3B6D11", background:"#EAF3DE", borderRadius:20, padding:"1px 7px" }}>📦 {it.storageBadge}</span>}
                            </div>
                            {it.notes && <div style={{ fontSize:12, color:"#555", marginTop:2 }}>{it.notes}</div>}
                            <div style={{ fontSize:11, color:"#aaa", marginTop:2 }}>{(it.date || "").replace("T", " ").slice(0, 16)}{it.by ? ` · ${it.by}` : ""}</div>
                          </div>
                          {it.source === "manual" && <button onClick={() => deleteJobEvent(it.raw)} title="Delete" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:15, alignSelf:"flex-start" }}>×</button>}
                        </div>
                      ))}
                    </div>}

                {jobEventForm ? (
                  <div style={{ border:"1px solid #e5e5e5", borderRadius:10, padding:"12px", marginTop:10, background:"#fafafa" }}>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      <Field label="Date *"><input style={inp} type="date" value={jobEventForm.event_date} onChange={e => setJE({ event_date:e.target.value })} /></Field>
                      <Field label="Event type *">
                        <select style={inp} value={jobEventForm.event_type} onChange={e => setJE({ event_type:e.target.value })}>
                          {JOB_EVENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                        </select>
                      </Field>
                      {meta?.storage && (
                        <Field label="Storage / warehouse (opcional)">
                          <select style={inp} value={jobEventForm.storage_id} onChange={e => { const tgt = storageTargets.find(s => s.key === e.target.value); setJE({ storage_id: e.target.value, storage_label: tgt?.label || "" }); }}>
                            <option value="">— None —</option>
                            {storageTargets.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                          </select>
                        </Field>
                      )}
                      <Field label="Trip # (opcional)"><input style={inp} value={jobEventForm.trip_ref} onChange={e => setJE({ trip_ref:e.target.value })} placeholder="Historical ref." /></Field>
                      <Field label="Notes" full><input style={inp} value={jobEventForm.notes} onChange={e => setJE({ notes:e.target.value })} placeholder="What happened" /></Field>
                    </div>
                    <div style={{ display:"flex", gap:8, justifyContent:"flex-end", marginTop:10 }}>
                      <Btn onClick={() => setJobEventForm(null)} style={{ padding:"5px 12px", fontSize:12 }}>Cancel</Btn>
                      <Btn primary onClick={() => saveJobEvent(jobDetail.key, repId)} style={{ padding:"5px 12px", fontSize:12 }}>Save event</Btn>
                    </div>
                  </div>
                ) : !jobEventsMissing && (
                  <div style={{ display:"flex", justifyContent:"flex-end", marginTop:8 }}>
                    <Btn onClick={() => setJobEventForm({ event_date: today(), event_type:"picked_up", notes:"", storage_id:"", storage_label:"", trip_ref:"" })} style={{ padding:"5px 12px", fontSize:12 }}>+ Add evento</Btn>
                  </div>
                )}
              </>
            );
          })()}

          <SectionLabel>{jobDetail.parts.length === 1 ? "Where it's stored" : `Where it's stored (${jobDetail.parts.length})`}</SectionLabel>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {jobDetail.parts.map(p => {
              const s = p.storage || {};
              const delivered = !!p.date_out;
              const isWh = !!p.warehouse;
              return (
                <div key={p.id} style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", background: delivered ? "#fafafa" : "#fff" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <span style={jobBadgeStyle(delivered)}>
                      <span style={{ width:6, height:6, borderRadius:"50%", background: delivered ? "#bbb" : "#639922" }} />
                      {delivered ? "Delivered" : "Active"}
                    </span>
                    <strong style={{ fontSize:13 }}>{isWh ? `🏭 Warehouse ${p.warehouse}` : (s.brand || "Unit")}</strong>
                    {p.split_group && <span style={{ fontSize:10.5, color:"#7C3AED", fontWeight:700 }} title="Split load — one portion of this job">✂️ {splitLabel(p)} · {Math.round(effCf(p))} CF</span>}
                    <span style={{ flex:1 }} />
                    {!jobSplitColMissing && !delivered && <Btn onClick={() => { setSplitJobRow(p); setSplitCf(String(Math.round(effCf(p) / 2))); setSplitDest(""); }} title="Dividir en dos camiones" style={{ padding:"4px 10px", fontSize:12 }}>✂️ Split</Btn>}
                    {!delivered
                      ? <Btn onClick={() => deliverJobs([p.id])} style={{ padding:"4px 10px", fontSize:12 }}>Mark delivered</Btn>
                      : <Btn onClick={() => undeliverJobs([p.id])} style={{ padding:"4px 10px", fontSize:12 }}>Desentregar</Btn>}
                  </div>
                  <div style={{ fontSize:13, color:"#444", display:"flex", flexDirection:"column", gap:3 }}>
                    {isWh ? (
                      <div>📍 Own warehouse — {p.warehouse}</div>
                    ) : (
                      <>
                        {s.address && <div>📍 {s.address}</div>}
                        <div>Unit: <strong style={{ fontFamily:"monospace" }}>{s.unit || "—"}</strong></div>
                        {s.gate_code && (
                          <div style={{ display:"inline-flex", alignItems:"center" }}>Gate code: <span style={{ fontFamily:"monospace", marginLeft:4 }}>{s.gate_code}</span><CopyButton value={s.gate_code} /></div>
                        )}
                      </>
                    )}
                    <div style={{ color:"#888" }}>In: {p.date_in || "—"}{delivered ? ` · Out: ${p.date_out}` : ""}</div>
                  </div>
                  {!isWh && (
                    <div style={{ marginTop:6 }}>
                      <span onClick={() => { setJobDetailKey(null); setDetailId(p.storage_id); }}
                        style={{ fontSize:12, color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>Ver unidad completa →</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <AuditInfo rec={jobDetail} />
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.brand||"Unit"}${detail.unit ? " — "+detail.unit : ""}${detail.state ? " · "+detail.state : ""}`} onClose={() => setDetailId(null)}
          footer={<>
            <Btn danger onClick={() => deleteRecord(detail.id)}>Delete</Btn>
            <Btn onClick={() => { setDetailId(null); openEdit(detail); }}>Edit unit</Btn>
            <Btn primary onClick={() => openAddJob(detail.id)}>+ Add job</Btn>
          </>}>
          <div style={{ marginBottom:10, display:"flex", alignItems:"center", gap:10 }}>
            <Badge situation={sit(detail)} />
            <span style={{ fontSize:13, color:"#888" }}>{activeJobsByStorage[detail.id] || 0} job(s) activo(s)</span>
          </div>
          <SectionLabel>Unit</SectionLabel>
          <DetailRow label="Company" value={detail.brand} />
          <DetailRow label="Address" value={detail.address} />
          <DetailRow label="Status" value={detail.state} />
          <DetailRow label="Zip code" value={detail.zip} />
          <DetailRow label="Unit" value={detail.unit} />
          <DetailRow label="Tamano" value={detail.size} />
          <DetailRow label="Gate Code" value={detail.gate_code} />
          <DetailRow label="Lock / Combo" value={detail.lock} />
          {!driverColMissing && <DetailRow label="Driver que abre" value={detail.driver_id ? (driverById[detail.driver_id]?.name || null) : null} />}
          <SectionLabel>Account</SectionLabel>
          <DetailRow label="Email" value={detail.email} />
          <DetailRow label="Account #" value={detail.account} />
          <DetailRow label="Phone" value={detail.phone} />
          <DetailRow label="Tarjeta" value={detail.card_on_file} />
          <DetailRow label="Monthly cost" value={detail.monthly_cost ? "$" + detail.monthly_cost : null} />
          <DetailRow label="Open date" value={detail.date_opened} />

          <SectionLabel>Payment</SectionLabel>
          <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13, alignItems:"center" }}>
            <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>Vencimiento de pago</span>
            <span style={{ fontWeight:500 }}>{fmtDateLocal(paymentDueDate(detail)) || "—"}</span>
            <span style={{ flex:1 }} />
            <PaymentBadge record={detail} situation={sit(detail)} />
          </div>
          <div style={{ display:"flex", gap:8, marginTop:10 }}>
            <Btn onClick={() => renewPayment(detail)}>Renew — add 30 days</Btn>
            {sit(detail) !== "Close" && <Btn danger onClick={() => closeStorage(detail)}>Cerrar storage</Btn>}
          </div>

          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", margin:"16px 0 8px" }}>
            <span style={{ fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em" }}>Job History</span>
            <span style={{ fontSize:11, color:"#bbb" }}>{activeJobsByStorage[detail.id] || 0} activo(s)</span>
          </div>
          <JobHistory
            storageId={detail.id}
            jobs={jobs.filter(j => j.storage_id === detail.id)}
            allJobs={jobs}
            userEmail={userEmail}
            dbReady={dbReady}
            onSetup={() => setShowSetup(true)}
            onChange={loadJobs}
          />
          <AuditInfo rec={detail} />
        </Modal>
      )}

      {showAdd && (
        <Modal title={editId ? "Edit unit" : "New unit"} onClose={() => setShowAdd(false)}
          footer={<>
            <Btn onClick={() => setShowAdd(false)}>Cancel</Btn>
            <Btn primary disabled={saving} onClick={saveForm}>{saving ? "Saving..." : "Save"}</Btn>
          </>}>
          <p style={{ fontSize:12, color:"#999", margin:"0 0 12px" }}>Datos fijos de la unidad. Los clientes y jobs se cargan aparte en el historial.</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Company"><input style={inp} list="brands-list" value={form.brand} onChange={e => setForm(f => ({...f, brand:e.target.value}))} placeholder="Choose or type (CubeSmart...)" /></Field>
            <Field label="Status"><input style={inp} list="states-list" value={form.state} onChange={e => setForm(f => ({...f, state:e.target.value.toUpperCase()}))} placeholder="TN" /></Field>
            <Field label="Zip code"><input style={inp} value={form.zip} onChange={e => setForm(f => ({...f, zip:e.target.value}))} placeholder="38555" /></Field>
            <Field label="Address" full><input style={inp} value={form.address} onChange={e => setForm(f => ({...f, address:e.target.value}))} placeholder="1870 West Ave, Crossville, TN 38555" /></Field>
            <Field label="Unit #">
              <input style={inp} value={form.unit} onChange={e => setForm(f => ({...f, unit:e.target.value}))} placeholder="G13" />
              <DupHint checking={stBrandChecking && (form.brand || "").trim() !== "" && (form.unit || "").trim() !== ""} tone="danger">
                {storageDup && <span>⚠️ {storageDup.brand} Unit {storageDup.unit}{storageDup.state ? ` in ${storageDup.state}` : ""} is already open in the system. <a onClick={() => { setShowAdd(false); setDetailId(storageDup.id); }} style={{ cursor:"pointer", textDecoration:"underline", fontWeight:700 }}>Ver storage</a></span>}
              </DupHint>
            </Field>
            <Field label="Tamano"><input style={inp} list="sizes-list" value={form.size} onChange={e => setForm(f => ({...f, size:e.target.value}))} placeholder="10x10" /></Field>
            <Field label="Gate Code"><input style={inp} value={form.gate_code} onChange={e => setForm(f => ({...f, gate_code:e.target.value}))} placeholder="*130438#" /></Field>
            <Field label="Lock / Combo"><input style={inp} value={form.lock} onChange={e => setForm(f => ({...f, lock:e.target.value}))} placeholder="use 8141 to unlock..." /></Field>
            {!driverColMissing && (
              <Field label="Driver que abre la unit">
                <select style={inp} value={form.driver_id} onChange={e => setForm(f => ({...f, driver_id:e.target.value}))}>
                  <option value="">— Sin asignar —</option>
                  {driversList.filter(d => d.active !== false || String(d.id) === String(form.driver_id)).map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Email"><input style={inp} value={form.email} onChange={e => setForm(f => ({...f, email:e.target.value}))} placeholder="service@..." /></Field>
            <Field label="Account #"><input style={inp} value={form.account} onChange={e => setForm(f => ({...f, account:e.target.value}))} placeholder="NONE" /></Field>
            <Field label="Phone"><input style={inp} value={form.phone} onChange={e => setForm(f => ({...f, phone:e.target.value}))} placeholder="(931) 555-0199" /></Field>
            <Field label="Unit status">
              <select style={inp} value={form.situation} onChange={e => setForm(f => ({...f, situation:e.target.value}))}>
                <option value="Open">Active (automatic based on jobs)</option>
                <option value="Close">Cerrada</option>
              </select>
            </Field>
            <Field label="Monthly cost ($)"><input style={inp} type="number" value={form.monthly_cost} onChange={e => setForm(f => ({...f, monthly_cost:e.target.value}))} placeholder="0" /></Field>
            <Field label="Tarjeta"><input style={inp} value={form.card_on_file} onChange={e => setForm(f => ({...f, card_on_file:e.target.value}))} placeholder="Visa ****1234" /></Field>
            <Field label="Open date"><input style={inp} type="date" value={form.date_opened} onChange={e => setForm(f => ({...f, date_opened:e.target.value}))} /></Field>
            <Field label="Payment due date"><input style={inp} type="date" value={form.payment_due_date} onChange={e => setForm(f => ({...f, payment_due_date:e.target.value}))} /></Field>
          </div>
        </Modal>
      )}

      {unitJobPicker && (() => {
        // Units the job can be attached to (physical lockers, not warehouses).
        const units = records.filter(r => r.space_type !== "warehouse")
          .sort((a, b) => (a.brand || "").localeCompare(b.brand || ""));
        const unitLabel = (r) => [r.brand || "Unit", r.unit && `#${r.unit}`, r.state].filter(Boolean).join(" · ");
        // Active jobs not already in the chosen unit.
        let candidates = [];
        if (ujUnitId) {
          const groups = new Map();
          for (const j of jobs) {
            if (j.date_out) continue;
            const k = jobKey(j);
            if (!groups.has(k)) groups.set(k, { key:k, job_number:j.job_number, customer:j.customer, date_in:j.date_in, here:false });
            if (String(j.storage_id) === String(ujUnitId)) groups.get(k).here = true;
          }
          candidates = [...groups.values()].filter(g => !g.here).sort((a, b) => (b.date_in || "").localeCompare(a.date_in || ""));
        }
        return (
          <Modal title="+ Job to a unit" onClose={() => setUnitJobPicker(false)}
            footer={<>
              <Btn onClick={() => setUnitJobPicker(false)}>Cancel</Btn>
              <Btn primary disabled={!ujUnitId || !ujKey || ujSaving} onClick={() => addExistingJobToUnit(ujKey, ujUnitId)}>
                {ujSaving ? "Adding..." : "Add to the unit"}
              </Btn>
            </>}>
            <div style={{ fontSize:13, color:"#666", marginBottom:14 }}>
              Choose a unit and add an existing job, or create a new one.
            </div>
            <Field label="Unit">
              <select style={inp} value={ujUnitId} onChange={e => { setUjUnitId(e.target.value); setUjKey(""); }}>
                <option value="">— Select unit —</option>
                {units.map(r => <option key={r.id} value={r.id}>{unitLabel(r)}</option>)}
              </select>
            </Field>
            <div style={{ height:10 }} />
            <Field label="Job existente">
              <select style={inp} value={ujKey} disabled={!ujUnitId} onChange={e => setUjKey(e.target.value)}>
                <option value="">{ujUnitId ? "— Select job —" : "Choose a unit first"}</option>
                {candidates.map(g => <option key={g.key} value={g.key}>{[g.job_number || "(no #)", g.customer].filter(Boolean).join(" — ")}</option>)}
              </select>
            </Field>
            {ujUnitId && candidates.length === 0 && (
              <div style={{ fontSize:12, color:"#999", marginTop:8 }}>No hay jobs activos disponibles para esta unidad.</div>
            )}
            <div style={{ display:"flex", alignItems:"center", gap:10, margin:"16px 0 4px" }}>
              <div style={{ flex:1, height:1, background:"#f0f0f0" }} />
              <span style={{ fontSize:11, color:"#bbb", textTransform:"uppercase", letterSpacing:"0.05em" }}>o</span>
              <div style={{ flex:1, height:1, background:"#f0f0f0" }} />
            </div>
            <Btn disabled={!ujUnitId} onClick={() => { const sid = Number(ujUnitId); setUnitJobPicker(false); openAddJob(sid); }} style={{ width:"100%", padding:"9px 14px" }}>
              + Create new job {ujUnitId ? "" : "(choose a unit)"}
            </Btn>
          </Modal>
        );
      })()}

      {whPicker && (() => {
        const name = whPicker.name;
        // Active jobs not already sitting in this warehouse, newest first.
        const groups = new Map();
        for (const j of jobs) {
          if (j.date_out) continue;
          const k = jobKey(j);
          if (!groups.has(k)) groups.set(k, { key:k, job_number:j.job_number, customer:j.customer, date_in:j.date_in, inHere:false });
          if (j.warehouse === name) groups.get(k).inHere = true;
        }
        const candidates = [...groups.values()].filter(g => !g.inHere)
          .sort((a, b) => (b.date_in || "").localeCompare(a.date_in || ""));
        return (
          <Modal title={`+ Job a ${name}`} onClose={() => setWhPicker(null)}
            footer={<>
              <Btn onClick={() => setWhPicker(null)}>Cancel</Btn>
              <Btn primary disabled={!whPickerKey || whPickerSaving} onClick={() => addExistingJobToWarehouse(whPickerKey, name)}>
                {whPickerSaving ? "Adding..." : `Add to ${name}`}
              </Btn>
            </>}>
            <div style={{ fontSize:13, color:"#666", marginBottom:14 }}>
              Add an existing job to <b>{name}</b>, or create a new one if it doesn't exist yet.
            </div>
            <Field label="Job existente">
              <select style={inp} value={whPickerKey} onChange={e => setWhPickerKey(e.target.value)}>
                <option value="">— Select job —</option>
                {candidates.map(g => (
                  <option key={g.key} value={g.key}>{[g.job_number || "(no #)", g.customer].filter(Boolean).join(" — ")}</option>
                ))}
              </select>
            </Field>
            {candidates.length === 0 && (
              <div style={{ fontSize:12, color:"#999", marginTop:8 }}>No hay otros jobs activos disponibles para agregar.</div>
            )}
            <div style={{ display:"flex", alignItems:"center", gap:10, margin:"16px 0 4px" }}>
              <div style={{ flex:1, height:1, background:"#f0f0f0" }} />
              <span style={{ fontSize:11, color:"#bbb", textTransform:"uppercase", letterSpacing:"0.05em" }}>o</span>
              <div style={{ flex:1, height:1, background:"#f0f0f0" }} />
            </div>
            <Btn onClick={() => { setWhPicker(null); openAddJobWarehouse(name); }} style={{ width:"100%", padding:"9px 14px" }}>+ Create new job</Btn>
          </Modal>
        );
      })()}

      {showAddJob && (
        <Modal title={editingJobKey ? "Edit job" : "New job"} onClose={() => setShowAddJob(false)}
          footer={<>
            <Btn onClick={() => setShowAddJob(false)}>Cancel</Btn>
            <Btn primary disabled={jobSaving} onClick={saveJob}>{jobSaving ? "Saving..." : (editingJobKey ? "Save changes" : "Save job")}</Btn>
          </>}>
          {(() => {
            const t = jobForm.job_type;
            const u = (k) => (e) => setJobForm(f => ({ ...f, [k]: e.target.value }));
            const uUp = (k) => (e) => setJobForm(f => ({ ...f, [k]: e.target.value.toUpperCase() }));

            const basicInfo = (
              <FormSection title="Basic info">
                <div style={fgrid}>
                  <Field label="Job # *">
                    <input style={inp} value={jobForm.job_number} onChange={u("job_number")} placeholder="B8417142" />
                    <DupHint checking={jobNumChecking && (jobForm.job_number || "").trim() !== ""} tone={jobNumberDup?.delivered ? "ok" : "warn"}>
                      {jobNumberDup && (jobNumberDup.delivered ? (
                        <span>ℹ️ This job was already delivered on {jobNumberDup.dateOut || jobNumberDup.date} — are you sure? <a onClick={() => { setShowAddJob(false); setJobDetailKey(jobNumberDup.key); }} style={{ cursor:"pointer", textDecoration:"underline", fontWeight:700 }}>Ver job</a></span>
                      ) : (
                        <span>⚠️ Job {jobNumberDup.job_number} already exists — {jobNumberDup.customer || "no client"}, {statusMeta(jobNumberDup.status).l}, {jobNumberDup.date}. <a onClick={() => { setShowAddJob(false); setJobDetailKey(jobNumberDup.key); }} style={{ cursor:"pointer", textDecoration:"underline", fontWeight:700 }}>Ver job</a></span>
                      ))}
                    </DupHint>
                  </Field>
                  <Field label="Job type *">
                    <select style={inp} value={jobForm.job_type} onChange={u("job_type")}>
                      {JOB_TYPES.map(x => <option key={x.v} value={x.v}>{x.l}{x.v==="full"?" (pickup → storage → delivery)":x.v==="direct"?" (pickup → delivery)":" (solo delivery)"}</option>)}
                    </select>
                  </Field>
                  <Field label="Broker">
                    <select style={inp} value={jobForm.broker_id} onChange={u("broker_id")}>
                      <option value="">— Sin broker —</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Client *"><input style={inp} value={jobForm.customer} onChange={u("customer")} placeholder="Client name" /></Field>
                  <Field label="Client phone"><input style={inp} value={jobForm.client_phone} onChange={u("client_phone")} placeholder="(555) 123-4567" /></Field>
                  <Field label="Client email"><input style={inp} value={jobForm.client_email} onChange={u("client_email")} placeholder="client@email.com" /></Field>
                  <Field label="Rep (interno)"><input style={inp} value={jobForm.rep} onChange={u("rep")} placeholder="Rep" /></Field>
                  <Field label="Status">
                    <select style={inp} value={jobForm.status} onChange={u("status")}>{STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}</select>
                  </Field>
                  <Field label="Calendar status (color)">
                    {(() => { const cm = calStatusMeta(jobForm.calendar_status) || CALENDAR_STATUSES[0]; return (
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span title="Calendar color" style={{ width:14, height:14, borderRadius:4, background:cm.bar, border:"1px solid rgba(0,0,0,0.1)", flexShrink:0 }} />
                        <select style={{ ...inp, flex:1 }} value={jobForm.calendar_status || "active"} disabled={calStatusMissing} onChange={u("calendar_status")}>
                          {CALENDAR_STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                        </select>
                      </div>
                    ); })()}
                    {calStatusMissing && (
                      <div style={{ fontSize:11, color:"#A35200", marginTop:4 }}>
                        Falta la columna <code>calendar_status</code> en la base. <button type="button" onClick={() => setShowSetup(true)} style={{ background:"none", border:"none", color:"#185FA5", textDecoration:"underline", cursor:"pointer", padding:0, fontSize:11 }}>Ver SQL</button> para activarla.
                      </div>
                    )}
                  </Field>
                </div>
                <div style={{ marginTop:10 }}>
                  <label style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>Driver{(jobForm.driver_ids?.length) ? ` (${jobForm.driver_ids.length})` : ""}</label>
                  {driversList.length === 0 ? (
                    <input style={{ ...inp, marginTop:4 }} list="drivers-list" value={jobForm.driver} onChange={u("driver")} placeholder="Add drivers in the Drivers section to multi-assign" />
                  ) : (
                    <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:130, overflowY:"auto", background:"#fff", marginTop:4 }}>
                      {driversList.filter(d => d.active !== false).map(d => {
                        const checked = Array.isArray(jobForm.driver_ids) && jobForm.driver_ids.includes(d.id);
                        return (
                          <label key={d.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                            <input type="checkbox" checked={checked} onChange={() => toggleJobDriver(d.id)} />
                            <span>🧑‍✈️ {d.name}{d.truck_id ? ` · ${d.truck_id}` : ""}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </FormSection>
            );

            const pickup = (
              <FormSection title="Pick up">
                <div style={fgrid}>
                  <Field label="Pick up from"><input style={inp} type="date" value={jobForm.pickup_date_from} onChange={u("pickup_date_from")} /></Field>
                  <Field label="Pick up to (opcional)"><input style={inp} type="date" value={jobForm.pickup_date_to} onChange={u("pickup_date_to")} /></Field>
                  <Field label="Pickup address" full><input style={inp} value={jobForm.pickup_address} onChange={u("pickup_address")} placeholder="Pickup address" /></Field>
                  <Field label="Pickup city"><input style={inp} value={jobForm.pickup_city} onChange={u("pickup_city")} placeholder="City" /></Field>
                  <Field label="Pickup state"><input style={inp} list="states-list" value={jobForm.pickup_state} onChange={uUp("pickup_state")} placeholder="NY" /></Field>
                  <Field label="Pickup zip"><input style={inp} value={jobForm.pickup_zip} onChange={u("pickup_zip")} placeholder="10001" /></Field>
                  <Field label="Extra stops" full><input style={inp} value={jobForm.extra_stops} onChange={u("extra_stops")} placeholder="paradas adicionales" /></Field>
                </div>
              </FormSection>
            );

            const delivery = (
              <FormSection title="Delivery">
                <div style={fgrid}>
                  <Field label="FADD *"><input style={inp} type="date" value={jobForm.fadd} onChange={u("fadd")} /></Field>
                  <Field label="Delivery date"><input style={inp} type="date" value={jobForm.delivery_date} onChange={u("delivery_date")} /></Field>
                  <Field label="Delivery address" full><input style={inp} value={jobForm.delivery_address} onChange={u("delivery_address")} placeholder="Delivery address" /></Field>
                  <Field label="Delivery city"><input style={inp} value={jobForm.delivery_city} onChange={u("delivery_city")} placeholder="City" /></Field>
                  <Field label="Delivery state"><input style={inp} list="states-list" value={jobForm.delivery_state} onChange={uUp("delivery_state")} placeholder="NJ" /></Field>
                  <Field label="Delivery zip"><input style={inp} value={jobForm.delivery_zip} onChange={u("delivery_zip")} placeholder="07030" /></Field>
                </div>
              </FormSection>
            );

            const load = (
              <FormSection title="Load / Carga">
                <div style={fgrid}>
                  <Field label="Volumen (CF) — estimado broker"><input style={inp} value={jobForm.volume} onChange={u("volume")} placeholder="ej: 1200" /></Field>
                  {!realCfMissing && <Field label="Real CF (medido al cargar)"><input style={inp} type="number" value={jobForm.real_cf ?? ""} onChange={u("real_cf")} placeholder="vacío = usa el estimado" /></Field>}
                  <Field label="Sticker color">
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ width:18, height:18, borderRadius:"50%", flexShrink:0, background: colorHex(jobForm.sticker_color) || "#fff", border:"1px solid #ccc" }} />
                      <input style={inp} list="sticker-colors-list" value={jobForm.sticker_color} onChange={u("sticker_color")} placeholder="Rojo, Azul..." />
                    </div>
                  </Field>
                  <Field label="Lot number"><input style={inp} value={jobForm.lot_number} onChange={u("lot_number")} placeholder="LOT-4821" /></Field>
                  <Field label="Carrier notes" full><input style={inp} value={jobForm.carrier_notes} onChange={u("carrier_notes")} placeholder="Notes for the carrier/driver" /></Field>
                  <Field label="Internal notes" full><input style={inp} value={jobForm.notes} onChange={u("notes")} placeholder="Job notes" /></Field>
                </div>
              </FormSection>
            );

            const padsMissingForm = Math.max(0, (jobForm.pads_received !== "" ? parseInt(jobForm.pads_received) : 0) - (jobForm.pads_returned !== "" ? parseInt(jobForm.pads_returned) : 0));
            const pads = (
              <FormSection title="Pads">
                <div style={fgrid}>
                  <Field label="Pads received from broker"><input style={inp} type="number" value={jobForm.pads_received} onChange={u("pads_received")} placeholder="0" /></Field>
                  <Field label="Pads returned (post-delivery)"><input style={inp} type="number" value={jobForm.pads_returned} onChange={u("pads_returned")} placeholder="0" /></Field>
                  <Field label="Pads missing (auto)"><div style={{ ...inp, background:"#fafafa", fontWeight:700, color: padsMissingForm > 0 ? "#A32D2D" : "#111" }}>{padsMissingForm}</div></Field>
                </div>
              </FormSection>
            );

            // Broker keeps a % of the collected job balance (reduces net job revenue).
            const brokerJobShareBlock = !brokerShareMissing && (() => {
              const on = numv(jobForm.broker_job_share_pct) > 0 || jobForm.broker_job_share_enabled;
              const collected = numv(jobForm.bol_collected) || (numv(jobForm.pickup_balance) + numv(jobForm.delivery_balance));
              const shareAmt = collected * numv(jobForm.broker_job_share_pct) / 100;
              return (
                <div style={{ gridColumn:"1/-1", padding:"10px 12px", background:"#FFF8F0", border:"1px solid #FAE6CF", borderRadius:9, marginTop:4 }}>
                  <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer", fontWeight:600 }}>
                    <input type="checkbox" checked={on} onChange={e => setJobForm(f => ({ ...f, broker_job_share_enabled: e.target.checked, broker_job_share_pct: e.target.checked ? f.broker_job_share_pct : "" }))} />
                    🤝 El broker se queda con un % del balance del job
                  </label>
                  {on && (
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
                      <Field label="Broker share % of balance"><input style={inp} type="number" value={jobForm.broker_job_share_pct} onChange={u("broker_job_share_pct")} placeholder="0" /></Field>
                      <Field label="Broker share amount (auto)"><div style={{ ...inp, background:"#fafafa", fontWeight:700, color:"#C2410C" }}>{money(shareAmt) || "$0"}</div></Field>
                    </div>
                  )}
                </div>
              );
            })();
            const financialsFull = (
              <FormSection title="Financiero">
                <div style={fgrid}>
                  <Field label="Estimate ($)"><input style={inp} type="number" value={jobForm.estimate} onChange={u("estimate")} placeholder="0" /></Field>
                  <Field label="Deposit ($)"><input style={inp} type="number" value={jobForm.deposit} onChange={u("deposit")} placeholder="0" /></Field>
                  <Field label="Pickup balance ($)"><input style={inp} type="number" value={jobForm.pickup_balance} onChange={u("pickup_balance")} placeholder="0" /></Field>
                  <Field label="Delivery balance ($)"><input style={inp} type="number" value={jobForm.delivery_balance} onChange={u("delivery_balance")} placeholder="0" /></Field>
                  <Field label="Precio / CF ($)"><input style={inp} type="number" value={jobForm.price_per_cf} onChange={u("price_per_cf")} placeholder="0.65" /></Field>
                  <Field label="Fuel surcharge (%)"><input style={inp} type="number" value={jobForm.fuel_surcharge_pct} onChange={u("fuel_surcharge_pct")} placeholder="5" /></Field>
                  {brokerJobShareBlock}
                </div>
              </FormSection>
            );

            const carrierTotal = parseCf(jobForm.volume) * numv(jobForm.carrier_rate_per_cf);
            const financialsBroker = (
              <FormSection title="Financiero (broker delivery)">
                <div style={fgrid}>
                  <Field label="BOL balance to collect from client ($)"><input style={inp} type="number" value={jobForm.bol_balance} onChange={u("bol_balance")} placeholder="0" /></Field>
                  <Field label="Carrier rate / CF ($)"><input style={inp} type="number" value={jobForm.carrier_rate_per_cf} onChange={u("carrier_rate_per_cf")} placeholder="0.55" /></Field>
                  <Field label="Carrier total (CF × rate)"><div style={{ ...inp, background:"#fafafa", fontWeight:700 }}>{money(carrierTotal) || "$0"}</div></Field>
                  {!settlementsMissing && (
                    <Field label="Closing sheet" full>
                      <select style={inp} value={jobForm.closing_sheet_id === "" || jobForm.closing_sheet_id == null ? "" : String(jobForm.closing_sheet_id)} onChange={e => setJobForm(f => ({...f, closing_sheet_id: e.target.value === "" ? "" : (e.target.value === "__new__" ? "__new__" : Number(e.target.value))}))}>
                        <option value="">— Sin closing sheet —</option>
                        {(() => { const cur = jobForm.closing_sheet_id; const linked = cur && cur !== "__new__" ? closingSheets.find(s => s.id === Number(cur)) : null; return (linked && linked.status !== "open") ? <option value={String(linked.id)}>#{linked.closing_sheet_number || linked.id} ({linked.status})</option> : null; })()}
                        {closingSheets.filter(s => s.status === "open").map(s => <option key={s.id} value={String(s.id)}>#{s.closing_sheet_number || s.id} · {brokerName(s.broker_id) || "no broker"}</option>)}
                        <option value="__new__">➕ Create new closing sheet</option>
                      </select>
                    </Field>
                  )}
                  <Field label="BOL collected ($)"><input style={inp} type="number" value={jobForm.bol_collected} onChange={u("bol_collected")} placeholder="0" /></Field>
                  <Field label="Payment method"><PaymentMethodSelect style={inp} value={jobForm.bol_payment_method} onChange={v => setJobForm(f => ({...f, bol_payment_method: v || ""}))} /></Field>
                  <Field label="Collection date"><input style={inp} type="date" value={jobForm.bol_collected_date} onChange={u("bol_collected_date")} /></Field>
                  {brokerJobShareBlock}
                </div>
              </FormSection>
            );

            const storageBlock = (
              <FormSection title={`Storage (opcional)${(jobForm.storage_ids.length + jobForm.warehouses.length) ? ` · ${jobForm.storage_ids.length + jobForm.warehouses.length}` : ""}`} defaultOpen={false}>
                <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:200, overflowY:"auto", background:"#fff" }}>
                  {(() => { const none = jobForm.storage_ids.length === 0 && jobForm.warehouses.length === 0; return (
                    <label onClick={() => setJobForm(f => ({ ...f, storage_ids: [], warehouses: [] }))}
                      style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: none ? "#f0fdf4" : "#fff" }}>
                      <input type="radio" readOnly checked={none} />
                      <span style={{ color: none ? "#111" : "#888" }}>— Unassigned —</span>
                    </label>
                  ); })()}
                  <div style={{ padding:"6px 10px", fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", background:"#fafafa" }}>Warehouses propios</div>
                  {WAREHOUSES.map(w => {
                    const checked = jobForm.warehouses.includes(w);
                    return (
                      <label key={w} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleJobWarehouse(w)} /><span>🏭 Warehouse {w}</span>
                      </label>
                    );
                  })}
                  <div style={{ padding:"6px 10px", fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", background:"#fafafa" }}>Units alquiladas</div>
                  {records.filter(r => r.space_type !== "warehouse").length === 0 ? (
                    <div style={{ padding:"10px 12px", fontSize:12, color:"#bbb" }}>No units added yet.</div>
                  ) : records.filter(r => r.space_type !== "warehouse").map(r => {
                    const checked = jobForm.storage_ids.includes(r.id);
                    return (
                      <label key={r.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleJobUnit(r.id)} />
                        <span>{[r.brand, r.unit && `Unit ${r.unit}`, r.state].filter(Boolean).join(" · ") || `Unit #${r.id}`}</span>
                      </label>
                    );
                  })}
                </div>
                <Field label="Date in (a storage)"><input style={{ ...inp, marginTop:8, maxWidth:200 }} type="date" value={jobForm.date_in} onChange={u("date_in")} /></Field>
              </FormSection>
            );

            const billingBlock = (
              <FormSection title="Client storage billing (optional)" defaultOpen={false}>
                <label style={{ display:"flex", alignItems:"center", gap:10, fontSize:13, cursor:"pointer", padding:"4px 0" }}>
                  <input type="checkbox" checked={!!jobForm.billing_active} onChange={e => setJobForm(f => ({...f, billing_active:e.target.checked}))} />
                  <span>Bill this client for storage (every 30 days)</span>
                </label>
                {jobForm.billing_active && (
                  <div style={{ ...fgrid, marginTop:8 }}>
                    <Field label="Monthly rate ($)"><input style={inp} type="number" value={jobForm.client_monthly_rate} onChange={u("client_monthly_rate")} placeholder="ej: 150" /></Field>
                    <Field label="First month free?">
                      <select style={inp} value={jobForm.first_month_free ? "yes" : "no"} onChange={e => setJobForm(f => ({...f, first_month_free: e.target.value === "yes"}))}>
                        <option value="no">No</option><option value="yes">Yes — bills after 30 days</option>
                      </select>
                    </Field>
                    <Field label="Billing start (auto, editable)" full>
                      <input style={inp} type="date" value={jobForm.billing_start_date || (jobForm.date_in ? (jobForm.first_month_free ? addDaysStr(jobForm.date_in, 30) : jobForm.date_in) : "")} onChange={u("billing_start_date")} />
                    </Field>
                  </div>
                )}
              </FormSection>
            );

            const directPickDeliver = (
              <FormSection title="Pick up + Delivery (same day)">
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))", gap:14 }}>
                  <div>
                    <div style={{ fontSize:10, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Pick up</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      <Field label="Pickup date"><input style={inp} type="date" value={jobForm.pickup_date_from} onChange={u("pickup_date_from")} /></Field>
                      <Field label="Pickup address"><input style={inp} value={jobForm.pickup_address} onChange={u("pickup_address")} placeholder="Pickup address" /></Field>
                      <Field label="Pickup city"><input style={inp} value={jobForm.pickup_city} onChange={u("pickup_city")} placeholder="City" /></Field>
                      <Field label="Pickup state"><input style={inp} list="states-list" value={jobForm.pickup_state} onChange={uUp("pickup_state")} placeholder="NY" /></Field>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:10, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Delivery</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      <Field label="FADD *"><input style={inp} type="date" value={jobForm.fadd} onChange={u("fadd")} /></Field>
                      <Field label="Delivery address"><input style={inp} value={jobForm.delivery_address} onChange={u("delivery_address")} placeholder="Delivery address" /></Field>
                      <Field label="Delivery city"><input style={inp} value={jobForm.delivery_city} onChange={u("delivery_city")} placeholder="City" /></Field>
                      <Field label="Delivery state"><input style={inp} list="states-list" value={jobForm.delivery_state} onChange={uUp("delivery_state")} placeholder="NJ" /></Field>
                    </div>
                  </div>
                </div>
              </FormSection>
            );

            return (
              <>
                {basicInfo}
                {t === "broker_delivery" && <>{delivery}{load}{pads}{financialsBroker}{storageBlock}</>}
                {t === "full" && <>{pickup}{delivery}{load}{pads}{financialsFull}{storageBlock}{billingBlock}</>}
                {t === "direct" && <>{directPickDeliver}{load}{pads}{financialsFull}</>}
              </>
            );
          })()}
          {jobErr && <div style={{ fontSize:12, color:"#b91c1c", marginTop:10 }}>{jobErr}</div>}
        </Modal>
      )}

      {capTarget && (
        <Modal title={capTarget.kind === "warehouse" ? `Capacidad — ${capTarget.name}` : "Unit capacity"} onClose={() => setCapTarget(null)}
          footer={<>
            <Btn onClick={() => setCapTarget(null)}>Cancel</Btn>
            <Btn primary onClick={saveCapacity}>Save</Btn>
          </>}>
          <Field label="Capacidad total (CF)">
            <input style={inp} type="number" autoFocus value={capTarget.value}
              onChange={e => setCapTarget(t => ({ ...t, value:e.target.value }))}
              onKeyDown={e => { if (e.key === "Enter") saveCapacity(); }}
              placeholder="ej: 10000" />
          </Field>
          <p style={{ fontSize:12, color:"#999", marginTop:8 }}>Cubic-feet capacity. Occupancy is calculated from the active jobs' volume (CF).</p>
        </Modal>
      )}

      {showImport && (
        <Modal title="Import from WhatsApp" onClose={() => setShowImport(false)}
          footer={<>
            <Btn onClick={() => setShowImport(false)}>Cancel</Btn>
            {importTab === "paste" && <Btn onClick={previewPaste}>Previsualizar</Btn>}
            <Btn primary disabled={saving || !pending.filter((_,i) => !excluded[i]).length} onClick={confirmImport}>
              {saving ? "Importando..." : `Importar (${pending.filter((_,i) => !excluded[i]).length})`}
            </Btn>
          </>}>
          <div style={{ display:"flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14 }}>
            <button onClick={() => { setImportTab("paste"); setPending([]); }} style={impTabStyle("paste")}>Pegar texto</button>
            <button onClick={() => { setImportTab("zip"); setPending([]); }} style={impTabStyle("zip")}>Subir ZIP del chat</button>
          </div>
          {importTab === "paste" && (
            <>
              <p style={{ fontSize:13, color:"#888", marginBottom:10 }}>Pega uno o varios mensajes del grupo de WhatsApp.</p>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)}
                placeholder={"Storage para: Elvin Medina\nGo Store It!\nsize: 10x10\nAddress: 1870 West Avenue, Crossville, TN\nUnit Number: G13\nGate Code: 130438"}
                style={{ ...inp, fontFamily:"monospace", fontSize:12, resize:"vertical", minHeight:120, display:"block", marginBottom:8 }} />
            </>
          )}
          {importTab === "zip" && (
            <>
              <p style={{ fontSize:13, color:"#888", marginBottom:10 }}>Subi el .zip exportado del chat de WhatsApp. Se procesa en tu navegador.</p>
              <div onDragOver={e => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)}
                onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleZip(f); }}
                onClick={() => fileRef.current.click()}
                style={{ border:`2px dashed ${isDragging ? "#378ADD" : "#ddd"}`, borderRadius:10, padding:"28px 16px", textAlign:"center", cursor:"pointer", background: isDragging ? "#E6F1FB" : "#fafafa", transition:"all .15s" }}>
                <div style={{ fontSize:28, marginBottom:8 }}>zip</div>
                <p style={{ fontSize:13, color:"#888" }}>Click or drag the .zip file here</p>
                {zipName && <p style={{ fontSize:13, fontWeight:600, color:"#111", marginTop:6 }}>{zipName}</p>}
              </div>
              <input ref={fileRef} type="file" accept=".zip" style={{ display:"none" }} onChange={e => handleZip(e.target.files[0])} />
              {zipStatus && <p style={{ fontSize:12, color: zipStatus.includes("Error")||zipStatus.includes("No se") ? "#b91c1c" : "#3B6D11", marginTop:8 }}>{zipStatus}</p>}
            </>
          )}
          {pending.length > 0 && (
            <div style={{ marginTop:14 }}>
              <div style={{ fontSize:12, fontWeight:600, color:"#3B6D11", marginBottom:8 }}>{pending.length} storage(s) detectados:</div>
              <div style={{ maxHeight:260, overflowY:"auto", display:"flex", flexDirection:"column", gap:6 }}>
                {pending.map((r, i) => (
                  <label key={i} style={{ display:"flex", alignItems:"flex-start", gap:8, fontSize:12, background: excluded[i] ? "#fafafa" : "#f0fdf4", borderRadius:8, padding:"8px 10px", cursor:"pointer", border:"1px solid", borderColor: excluded[i] ? "#efefef" : "#bbf7d0" }}>
                    <input type="checkbox" checked={!excluded[i]} onChange={e => setExcluded(ex => ({...ex, [i]: !e.target.checked}))} style={{ marginTop:1 }} />
                    <div>
                      <span style={{ fontWeight:600 }}>{r.driver||"No name"}</span>
                      <span style={{ color:"#666" }}> · {r.brand||"?"} · Unit {r.unit||"?"}</span>
                      {r.address && <div style={{ color:"#888", marginTop:2 }}>{r.address}</div>}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}

      {showSetup && (() => {
        const allSql = [STORAGE_JOBS_SQL, JOB_COLS_SQL, CRM_V2_SQL, BILLING_SQL, CRM_V3_SQL, SETTLEMENTS_SQL, TRIPS_SQL, TRIP_STOPS_SQL, EQUIPMENT_SQL, JOB_EVENTS_SQL, EXTRAS_SQL, PAYMENTS_SQL, COMPLIANCE_SQL].join("\n\n");
        return (
        <Modal title="Database setup" onClose={() => setShowSetup(false)}
          footer={<Btn primary onClick={() => setShowSetup(false)}>Listo</Btn>}>
          <p style={{ fontSize:13, color:"#555", lineHeight:1.6, marginTop:0 }}>
            The public key cannot create tables/columns. Run this SQL <strong>once</strong> in the
            SQL Editor de Supabase. Incluye <strong>storage_jobs</strong>, las columnas de Dispatching, la tabla
            <strong> brokers</strong> (with common brokers pre-loaded) and balances. Then reload.
          </p>
          <pre style={{ background:"#0f172a", color:"#e2e8f0", borderRadius:10, padding:"14px", fontSize:11.5, lineHeight:1.5, overflowX:"auto", whiteSpace:"pre" }}>{allSql}</pre>
          <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
            <Btn onClick={() => {
              navigator.clipboard?.writeText(allSql).then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500); }).catch(() => {});
            }}>{sqlCopied ? "✓ Copied" : "Copy SQL"}</Btn>
          </div>
        </Modal>
        );
      })()}

      {showBrokerModal && (
        <Modal title={editingBrokerId ? "Edit broker" : "New broker"} onClose={() => setShowBrokerModal(false)}
          footer={<>
            <Btn onClick={() => setShowBrokerModal(false)}>Cancel</Btn>
            <Btn primary disabled={brokerSaving || !brokerForm.name.trim()} onClick={saveBroker}>{brokerSaving ? "Saving..." : "Save"}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Name" full><input style={inp} value={brokerForm.name} onChange={e => setBrokerForm(f => ({...f, name:e.target.value}))} placeholder="Allied Van Lines" /></Field>
            <Field label="Contact"><input style={inp} value={brokerForm.contact_name} onChange={e => setBrokerForm(f => ({...f, contact_name:e.target.value}))} placeholder="Contact name" /></Field>
            <Field label="Phone"><input style={inp} value={brokerForm.contact_phone} onChange={e => setBrokerForm(f => ({...f, contact_phone:e.target.value}))} placeholder="(555) 123-4567" /></Field>
            <Field label="Email" full><input style={inp} value={brokerForm.contact_email} onChange={e => setBrokerForm(f => ({...f, contact_email:e.target.value}))} placeholder="ops@broker.com" /></Field>
            <Field label="Notes" full><input style={inp} value={brokerForm.notes} onChange={e => setBrokerForm(f => ({...f, notes:e.target.value}))} placeholder="Notes" /></Field>
          </div>
        </Modal>
      )}

      {showDriverModal && (
        <Modal title={editingDriverId ? "Edit driver" : "New driver"} onClose={() => setShowDriverModal(false)}
          footer={<>
            <Btn onClick={() => setShowDriverModal(false)}>Cancel</Btn>
            <Btn primary disabled={driverSaving || !driverForm.name.trim()} onClick={saveDriver}>{driverSaving ? "Saving..." : "Save"}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Name" full><input style={inp} value={driverForm.name} onChange={e => setDriverForm(f => ({...f, name:e.target.value}))} placeholder="Driver name" /></Field>
            <Field label="Phone"><input style={inp} value={driverForm.phone} onChange={e => setDriverForm(f => ({...f, phone:e.target.value}))} placeholder="(555) 123-4567" /></Field>
            <Field label="Truck ID"><input style={inp} value={driverForm.truck_id} onChange={e => setDriverForm(f => ({...f, truck_id:e.target.value}))} placeholder="ej: T-12" /></Field>
            <Field label="WhatsApp group link" full><input style={inp} value={driverForm.whatsapp_group_link} onChange={e => setDriverForm(f => ({...f, whatsapp_group_link:e.target.value}))} placeholder="https://chat.whatsapp.com/..." /></Field>
            <Field label="Notes" full><input style={inp} value={driverForm.notes} onChange={e => setDriverForm(f => ({...f, notes:e.target.value}))} placeholder="Notes" /></Field>
            <Field label="Status">
              <select style={inp} value={driverForm.active ? "yes" : "no"} onChange={e => setDriverForm(f => ({...f, active: e.target.value === "yes"}))}>
                <option value="yes">Active</option><option value="no">Inactivo</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {showBillingModal && (() => {
        const f = billingForm;
        const setF = (fields) => setBillingForm(p => ({ ...p, ...fields }));
        const q = billingJobSearch.trim().toLowerCase();
        const groups = [...extraJobGroups.values()];
        const matches = (q ? groups.filter(g => (g.job_number || "").toLowerCase().includes(q) || (g.customer || "").toLowerCase().includes(q)) : groups).slice(0, 40);
        return (
          <Modal title={f.editing ? "Edit storage billing" : "Activate storage billing"} onClose={() => setShowBillingModal(false)}
            footer={<>
              <Btn onClick={() => setShowBillingModal(false)}>Cancel</Btn>
              <Btn primary disabled={billingSaving || !f.jobKey} onClick={saveBilling}>{billingSaving ? "Saving..." : (f.editing ? "Save changes" : "Activate billing")}</Btn>
            </>}>
            <Field label="Job">
              {f.jobKey ? (
                <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                  <span style={{ fontFamily:"monospace", fontWeight:700 }}>{f.job_number || "(no #)"}</span>
                  <span style={{ fontSize:12, color:"#666" }}>{f.customer || "—"}</span>
                  {!f.editing && <button onClick={() => setF({ jobKey:"", job_id:"", customer:"", job_number:"" })} style={{ border:"none", background:"none", cursor:"pointer", color:"#999", fontSize:12, textDecoration:"underline" }}>change</button>}
                </div>
              ) : (
                <>
                  <input style={inp} value={billingJobSearch} onChange={e => setBillingJobSearch(e.target.value)} placeholder="Search by job # or client name…" />
                  {q && (
                    <div style={{ border:"1px solid #f0f0f0", borderRadius:8, marginTop:6, maxHeight:170, overflowY:"auto" }}>
                      {matches.length === 0 ? <div style={{ padding:"10px", fontSize:12, color:"#bbb" }}>No results.</div>
                        : matches.map(g => (
                          <button key={g.key} onClick={() => pickBillingJob(g)} style={{ display:"block", width:"100%", textAlign:"left", padding:"7px 10px", border:"none", borderBottom:"1px solid #f6f6f6", background:"#fff", cursor:"pointer", fontSize:12.5 }}>
                            <span style={{ fontFamily:"monospace", fontWeight:600 }}>{g.job_number || "(no #)"}</span> · {g.customer || "—"}
                          </button>
                        ))}
                    </div>
                  )}
                </>
              )}
            </Field>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
              <Field label="Monthly rate ($)"><input style={inp} type="number" value={f.client_monthly_rate} onChange={e => setF({ client_monthly_rate:e.target.value })} placeholder="e.g. 150" /></Field>
              <Field label="Billing start date">
                <input style={inp} type="date" value={f.billing_start_date} onChange={e => setF({ billing_start_date:e.target.value })} />
              </Field>
            </div>
            <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer", marginTop:10 }}>
              <input type="checkbox" checked={!!f.first_month_free} onChange={e => setF({ first_month_free: e.target.checked })} />
              First month free
            </label>
            {!billingNotesMissing && <Field label="Notes" full><input style={{ ...inp, marginTop:10 }} value={f.billing_notes} onChange={e => setF({ billing_notes:e.target.value })} placeholder="Optional notes" /></Field>}
            <div style={{ marginTop:10, fontSize:11.5, color:"#999" }}>Billing records for each 30-day period are generated automatically.</div>
          </Modal>
        );
      })()}

      {showTruckModal && (
        <Modal title={editingTruckId ? "Edit truck" : "New truck"} onClose={() => setShowTruckModal(false)}
          footer={<>
            <Btn onClick={() => setShowTruckModal(false)}>Cancel</Btn>
            <Btn primary disabled={truckSaving || !truckForm.name.trim()} onClick={saveTruck}>{truckSaving ? "Saving..." : "Save"}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Name / number *"><input style={inp} value={truckForm.name} onChange={e => setTruckForm(f => ({...f, name:e.target.value}))} placeholder="Truck 1 / Box 26'" /></Field>
            <Field label="Patente"><input style={inp} value={truckForm.plate} onChange={e => setTruckForm(f => ({...f, plate:e.target.value}))} placeholder="ABC-1234" /></Field>
            <Field label="Capacidad (CF)"><input style={inp} type="number" value={truckForm.capacity_cf} onChange={e => setTruckForm(f => ({...f, capacity_cf:e.target.value}))} placeholder="ej: 1600" /></Field>
            <Field label="Status">
              <select style={inp} value={truckForm.active ? "yes" : "no"} onChange={e => setTruckForm(f => ({...f, active: e.target.value === "yes"}))}><option value="yes">Active</option><option value="no">Inactivo</option></select>
            </Field>
            <Field label="Notes" full><input style={inp} value={truckForm.notes} onChange={e => setTruckForm(f => ({...f, notes:e.target.value}))} placeholder="Notes" /></Field>
          </div>

          <SectionLabel>Vehicle info</SectionLabel>
          {truckColsMissing && (
            <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:8, padding:"8px 11px", marginBottom:10, fontSize:12, color:"#854F0B", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <span>Run the setup SQL once to save this data.</span>
              <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:6, padding:"3px 9px", cursor:"pointer", fontSize:11 }}>View SQL</button>
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Year"><input style={inp} type="number" value={truckForm.year} onChange={e => setTruckForm(f => ({...f, year:e.target.value}))} placeholder="2019" /></Field>
            <Field label="Make"><input style={inp} value={truckForm.make} onChange={e => setTruckForm(f => ({...f, make:e.target.value}))} placeholder="Freightliner, International, Volvo…" /></Field>
            <Field label="Model"><input style={inp} value={truckForm.model} onChange={e => setTruckForm(f => ({...f, model:e.target.value}))} placeholder="Cascadia, LT, VNL…" /></Field>
            <Field label="VIN"><input style={inp} maxLength={17} value={truckForm.vin} onChange={e => setTruckForm(f => ({...f, vin: e.target.value.toUpperCase().slice(0, 17)}))} placeholder="17 caracteres" /></Field>
            <Field label="License plate"><input style={inp} value={truckForm.license_plate} onChange={e => setTruckForm(f => ({...f, license_plate:e.target.value}))} placeholder="ABC-1234" /></Field>
            <Field label="License state">
              <input style={inp} list="states-list" maxLength={2} value={truckForm.license_state} onChange={e => setTruckForm(f => ({...f, license_state: e.target.value.toUpperCase().slice(0, 2)}))} placeholder="NJ" />
            </Field>
          </div>
        </Modal>
      )}

      {locModal && (
        <Modal title={`Location · ${locModal.name}`} onClose={() => setLocModal(null)}
          footer={<>
            <Btn onClick={() => setLocModal(null)}>Cancel</Btn>
            <Btn primary disabled={locBusy} onClick={saveLoc}>{locBusy ? "Saving..." : "Save location"}</Btn>
          </>}>
          <div style={{ fontSize:12.5, color:"#666", marginBottom:12 }}>
            Set the truck's current location by address (we look it up on the map) or paste the coordinates. Once we connect the Verizon API, this will update automatically.
          </div>
          <Field label="Search by address / city">
            <div style={{ display:"flex", gap:8 }}>
              <input style={{ ...inp, flex:1 }} value={locForm.query} onChange={e => setLocForm(f => ({...f, query:e.target.value}))}
                onKeyDown={e => { if (e.key === "Enter") geocodeLoc(); }} placeholder="ej: Atlanta, GA  ·  5050 N 13th St, Terre Haute, IN" />
              <Btn onClick={geocodeLoc} disabled={locBusy}>{locBusy ? "..." : "Search"}</Btn>
            </div>
          </Field>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginTop:10 }}>
            <Field label="Lat"><input style={inp} value={locForm.lat} onChange={e => setLocForm(f => ({...f, lat:e.target.value}))} placeholder="33.749" /></Field>
            <Field label="Lng"><input style={inp} value={locForm.lng} onChange={e => setLocForm(f => ({...f, lng:e.target.value}))} placeholder="-84.388" /></Field>
            <Field label="Status">
              <select style={inp} value={locForm.status} onChange={e => setLocForm(f => ({...f, status:e.target.value}))}>
                <option value="moving">En movimiento</option>
                <option value="stopped">Detenido</option>
                <option value="unknown">Sin datos</option>
              </select>
            </Field>
          </div>
          <Field label="Label / address"><input style={{ ...inp, marginTop:10 }} value={locForm.label} onChange={e => setLocForm(f => ({...f, label:e.target.value}))} placeholder="Address or reference visible in the list" /></Field>
          {locErr && <div style={{ fontSize:12, color:"#b91c1c", marginTop:10 }}>{locErr}</div>}
        </Modal>
      )}

      {truckDetailId && (() => {
        const tk = trucksList.find(t => t.id === truckDetailId);
        if (!tk) return null;
        const sub = truckSubtitle(tk);
        const activeTrip = trips.find(tp => tp.truck_id === tk.id && TRIP_ACTIVE(tp.status));
        const load = activeTrip ? tripCalc(activeTrip).loadedCf : 0;
        const cap = numv(tk.capacity_cf);
        return (
          <Modal title={`Truck · ${tk.name}`} onClose={() => setTruckDetailId(null)}
            footer={<>
              <Btn onClick={() => { setTruckDetailId(null); openEditTruck(tk); }}>Edit</Btn>
              <Btn primary onClick={() => setTruckDetailId(null)}>Close</Btn>
            </>}>
            {sub && <div style={{ fontSize:13, color:"#666", marginTop:-4, marginBottom:8 }}>{sub}</div>}
            <DetailRow label="Make / Model" value={[tk.make, tk.model].filter(Boolean).join(" ") || null} />
            <DetailRow label="Year" value={tk.year || null} />
            <DetailRow label="VIN" value={tk.vin || null} />
            <DetailRow label="License plate" value={[tk.license_plate, tk.license_state].filter(Boolean).join(" · ") || null} />
            <DetailRow label="Patente" value={tk.plate || null} />
            <DetailRow label="Capacidad" value={cap > 0 ? `${cap.toLocaleString()} CF` : null} />
            <DetailRow label="Current load" value={activeTrip ? `${Math.round(load).toLocaleString()} CF${cap > 0 ? ` · ${Math.min(100, Math.round((load / cap) * 100))}%` : ""}` : "No active trip"} />
            <DetailRow label="Status" value={tk.active !== false ? "Active" : "Inactivo"} />
            {tk.notes && <DetailRow label="Notes" value={tk.notes} />}
          </Modal>
        );
      })()}

      {showCompanyModal && (
        <Modal title={editingCompanyId ? "Edit company" : "New company"} onClose={() => setShowCompanyModal(false)}
          footer={<>
            <Btn onClick={() => setShowCompanyModal(false)}>Cancel</Btn>
            <Btn primary disabled={companySaving || !companyForm.name.trim()} onClick={saveCompany}>{companySaving ? "Saving..." : "Save"}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Name *" full><input style={inp} value={companyForm.name} onChange={e => setCompanyForm(f => ({...f, name:e.target.value}))} placeholder="No Borders Moving LLC" /></Field>
            <Field label="DOT number"><input style={inp} value={companyForm.dot_number} onChange={e => setCompanyForm(f => ({...f, dot_number:e.target.value}))} placeholder="1234567" /></Field>
            <Field label="MC number"><input style={inp} value={companyForm.mc_number} onChange={e => setCompanyForm(f => ({...f, mc_number:e.target.value}))} placeholder="MC-123456" /></Field>
            <Field label="EIN"><input style={inp} value={companyForm.ein} onChange={e => setCompanyForm(f => ({...f, ein:e.target.value}))} placeholder="12-3456789" /></Field>
            <Field label="State"><input style={inp} list="states-list" maxLength={2} value={companyForm.state} onChange={e => setCompanyForm(f => ({...f, state: e.target.value.toUpperCase().slice(0,2)}))} placeholder="NJ" /></Field>
            <Field label="Phone"><input style={inp} value={companyForm.phone} onChange={e => setCompanyForm(f => ({...f, phone:e.target.value}))} placeholder="(555) 123-4567" /></Field>
            <Field label="Email"><input style={inp} value={companyForm.email} onChange={e => setCompanyForm(f => ({...f, email:e.target.value}))} placeholder="legal@company.com" /></Field>
            <Field label="Address" full><input style={inp} value={companyForm.address} onChange={e => setCompanyForm(f => ({...f, address:e.target.value}))} placeholder="Address" /></Field>
            <Field label="Status">
              <select style={inp} value={companyForm.active ? "yes" : "no"} onChange={e => setCompanyForm(f => ({...f, active: e.target.value === "yes"}))}><option value="yes">Active</option><option value="no">Inactiva</option></select>
            </Field>
            <Field label="Notes" full><input style={inp} value={companyForm.notes} onChange={e => setCompanyForm(f => ({...f, notes:e.target.value}))} placeholder="Notes" /></Field>
          </div>
        </Modal>
      )}

      {showDocModal && (() => {
        const entityList = docForm.entity_type === "company" ? companies.map(c => ({ id:c.id, name:c.name }))
          : docForm.entity_type === "truck" ? trucksList.map(t => ({ id:t.id, name:t.name }))
          : driversList.map(d => ({ id:d.id, name:d.name }));
        const typeKeys = [...new Set([...(DOC_GRID[docForm.entity_type] || []), ...Object.keys(DOC_TYPE_LABELS)])];
        const setF = (fields) => setDocForm(f => ({ ...f, ...fields }));
        const st = docStatus(docForm);
        return (
          <Modal title={editingDocId ? "Edit document" : "New document"} onClose={() => setShowDocModal(false)}
            footer={<>
              <Btn onClick={() => setShowDocModal(false)}>Cancel</Btn>
              <Btn primary disabled={docSaving || !docForm.entity_id} onClick={saveDoc}>{docSaving ? "Saving..." : "Save"}</Btn>
            </>}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <Field label="Entity type">
                <select style={inp} value={docForm.entity_type} onChange={e => setF({ entity_type:e.target.value, entity_id:"", document_type:(DOC_GRID[e.target.value] || ["other"])[0] })}>
                  <option value="company">Company</option><option value="truck">Truck</option><option value="driver">Driver</option>
                </select>
              </Field>
              <Field label="Entity *">
                <select style={{ ...inp, borderColor: docForm.entity_id ? "#e5e5e5" : "#fca5a5" }} value={docForm.entity_id} onChange={e => setF({ entity_id:e.target.value })}>
                  <option value="">— Select —</option>
                  {entityList.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </Field>
              <Field label="Document type">
                <select style={inp} value={docForm.document_type} onChange={e => setF({ document_type:e.target.value, document_name: docForm.document_name || docTypeLabel(e.target.value) })}>
                  {typeKeys.map(k => <option key={k} value={k}>{DOC_TYPE_LABELS[k] || k}</option>)}
                </select>
              </Field>
              <Field label="Document name"><input style={inp} value={docForm.document_name} onChange={e => setF({ document_name:e.target.value })} placeholder="ej: Cargo insurance" /></Field>
              <Field label="No. / policy / certificate"><input style={inp} value={docForm.document_number} onChange={e => setF({ document_number:e.target.value })} placeholder="N°" /></Field>
              <Field label="Issuer"><input style={inp} value={docForm.issuer} onChange={e => setF({ issuer:e.target.value })} placeholder="Aseguradora / agencia" /></Field>
              <Field label="Issue date"><input style={inp} type="date" value={docForm.issue_date} onChange={e => setF({ issue_date:e.target.value })} /></Field>
              <Field label="Due date"><input style={inp} type="date" value={docForm.expiry_date} onChange={e => setF({ expiry_date:e.target.value })} /></Field>
              <Field label="Notes" full><input style={inp} value={docForm.notes} onChange={e => setF({ notes:e.target.value })} placeholder="Notes" /></Field>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:10, fontSize:12.5 }}>
              <span style={{ color:"#888" }}>Status:</span><ComplianceBadge status={st} />
            </div>
            <SectionLabel>File (photo or PDF)</SectionLabel>
            <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) uploadComplianceDoc(f); }}
              style={{ border:"2px dashed #ddd", borderRadius:10, padding:"16px", textAlign:"center", background:"#fafafa", fontSize:12.5, color:"#888" }}>
              {compDocUploading ? "Subiendo…" : (
                <>
                  Drag a file here or{" "}
                  <label style={{ color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>
                    choose one
                    <input type="file" accept="image/*,application/pdf" style={{ display:"none" }} onChange={e => { const f = e.target.files[0]; if (f) uploadComplianceDoc(f); e.target.value = ""; }} />
                  </label>
                  {docForm.document_url && <div style={{ marginTop:8 }}><a href={docForm.document_url} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E" }}>📎 Archivo cargado — ver</a></div>}
                </>
              )}
            </div>
          </Modal>
        );
      })()}

      {showEmpModal && (
        <Modal title="Reps / Employees" onClose={() => { setShowEmpModal(false); setEmpDetailId(null); }}
          footer={<Btn onClick={() => { setShowEmpModal(false); setEmpDetailId(null); }}>Close</Btn>}>
          <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:14 }}>
            {employees.length === 0 ? <div style={{ fontSize:13, color:"#bbb" }}>No employees added yet.</div>
              : employees.map(em => (
                <div key={em.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}>
                  <button onClick={() => setEmpDetailId(id => id === em.id ? null : em.id)} style={{ fontWeight:600, background:"none", border:"none", padding:0, cursor:"pointer", color: empDetailId === em.id ? "#185FA5" : "#111", textDecoration:"underline" }}>{em.name}</button>
                  {em.role && <span style={{ fontSize:11, color:"#888" }}>· {em.role}</span>}
                  <span style={{ flex:1 }} />
                  <button onClick={() => deleteEmployee(em)} title="Delete" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:16, lineHeight:1 }}>×</button>
                </div>
              ))}
          </div>
          {empDetailId && (() => {
            const emp = empById[empDetailId];
            const mine = jobExtras.filter(e => e.active !== false && String(e.rep_id) === String(empDetailId));
            const byMonth = {}; const history = [];
            for (const e of mine) {
              const k = jobKeyByRowId[e.job_id]; const g = k ? extraJobGroups.get(k) : null;
              const mo = g ? groupMonth(g) : (e.created_at || "").slice(0, 7);
              if (!byMonth[mo]) byMonth[mo] = { amount:0, comm:0 };
              byMonth[mo].amount += numv(e.amount); byMonth[mo].comm += numv(e.rep_commission_amount);
              history.push({ e, g, mo });
            }
            const months = Object.keys(byMonth).sort().reverse();
            history.sort((a, b) => (b.mo).localeCompare(a.mo) || (b.g?.job_number || "").localeCompare(a.g?.job_number || ""));
            const moLabel = (mo) => { const [y, m] = mo.split("-"); return m ? `${MONTHS_ES[parseInt(m) - 1]} ${y}` : mo; };
            return (
              <div style={{ background:"#F8FAFC", border:"1px solid #e8eef4", borderRadius:10, padding:"12px 14px", marginBottom:14 }}>
                <div style={{ fontSize:13, fontWeight:700, marginBottom:8 }}>Profile of {emp?.name} · commissions</div>
                {months.length === 0 ? <div style={{ fontSize:12, color:"#999" }}>No extras recorded yet.</div> : (<>
                  <SectionLabel>Commission per month</SectionLabel>
                  <div style={{ display:"flex", flexDirection:"column", gap:3, marginBottom:8 }}>
                    {months.map(mo => (
                      <div key={mo} style={{ display:"flex", justifyContent:"space-between", fontSize:12.5, padding:"3px 0" }}>
                        <span>{moLabel(mo)}</span>
                        <span style={{ color:"#888" }}>extras ${Math.round(byMonth[mo].amount).toLocaleString()} · <b style={{ color:"#185FA5" }}>commission ${Math.round(byMonth[mo].comm).toLocaleString()}</b></span>
                      </div>
                    ))}
                  </div>
                  <SectionLabel>Historial de extras ({history.length})</SectionLabel>
                  <div style={{ maxHeight:200, overflowY:"auto" }}>
                    {history.map(({ e, g, mo }) => (
                      <div key={e.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, padding:"4px 0", borderBottom:"1px solid #eef2f6", flexWrap:"wrap" }}>
                        <button onClick={() => { setShowEmpModal(false); setEmpDetailId(null); if (g) setJobDetailKey(g.key); }} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{g?.job_number || "(ver)"}</button>
                        <span>{extraTypeLabel(e.extra_type)}</span>
                        <span style={{ color:"#888" }}>{moLabel(mo)}</span>
                        <span style={{ flex:1 }} />
                        <span>{money(e.amount) || "$0"}</span>
                        <span style={{ color:"#185FA5", fontWeight:700 }}>{money(e.rep_commission_amount) || "$0"}</span>
                      </div>
                    ))}
                  </div>
                </>)}
              </div>
            );
          })()}
          <SectionLabel>Add empleado</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Name *"><input style={inp} value={empForm.name} onChange={e => setEmpForm(f => ({...f, name:e.target.value}))} placeholder="Name" /></Field>
            <Field label="Rol"><input style={inp} value={empForm.role} onChange={e => setEmpForm(f => ({...f, role:e.target.value}))} placeholder="Sales rep / Manager" /></Field>
            <Field label="Phone"><input style={inp} value={empForm.phone} onChange={e => setEmpForm(f => ({...f, phone:e.target.value}))} placeholder="Phone" /></Field>
            <Field label="Email"><input style={inp} value={empForm.email} onChange={e => setEmpForm(f => ({...f, email:e.target.value}))} placeholder="Email" /></Field>
          </div>
          <div style={{ marginTop:12 }}><Btn primary disabled={empSaving || !empForm.name.trim()} onClick={saveEmployee}>{empSaving ? "Saving..." : "+ Add"}</Btn></div>
        </Modal>
      )}

      {quickExtra && (() => {
        const locked = EXTRA_LOCKED_DRIVER(quickExtra.extra_type);
        const isCf = quickExtra.extra_type === "extra_cf";
        const setQ = (fields) => setQuickExtra(q => ({ ...q, ...fields }));
        const jobFuel = jobs.find(j => j.id === Number(quickExtra.jobId))?.fuel_surcharge_pct;
        // Payments-page flow: the job is picked inside the modal.
        const exGroups = [...extraJobGroups.values()];
        const exQ = extraJobSearch.trim().toLowerCase();
        const exMatches = (exQ ? exGroups.filter(g => (g.job_number || "").toLowerCase().includes(exQ) || (g.customer || "").toLowerCase().includes(exQ)) : exGroups).slice(0, 40);
        const exSelected = quickExtra.jobId ? exGroups.find(g => String(g.repId) === String(quickExtra.jobId) || g.ids.includes(Number(quickExtra.jobId))) : null;
        const pickJob = (g) => {
          const firstDriver = (Array.isArray(g.driver_ids) && g.driver_ids.length ? g.driver_ids[0] : "") || "";
          const jf = jobs.find(j => j.id === g.repId)?.fuel_surcharge_pct;
          setQ({ jobId: g.repId, driver_id: quickExtra.driver_id || firstDriver, fuel_surcharge_pct: quickExtra.fuel_surcharge_pct === "" ? (jf ?? "") : quickExtra.fuel_surcharge_pct });
          setExtraJobSearch("");
        };
        const needsJob = !quickExtra.id && quickExtra._pickJob;
        // Re-apply default %s whenever type or generated_by changes; pull job fuel% for extra_cf.
        const onType = (v) => { const gen = EXTRA_LOCKED_DRIVER(v) ? "driver_only" : quickExtra.generated_by; const d = commissionDefaults(v, gen); setQ({ extra_type:v, generated_by:gen, driver_commission_pct:d.driver, rep_commission_pct:d.rep, rep_id: gen === "driver_only" ? "" : quickExtra.rep_id, fuel_surcharge_pct: v === "extra_cf" && (quickExtra.fuel_surcharge_pct === "" || quickExtra.fuel_surcharge_pct == null) ? (jobFuel ?? "") : quickExtra.fuel_surcharge_pct }); };
        const onGen = (v) => { const d = commissionDefaults(quickExtra.extra_type, v); setQ({ generated_by:v, driver_commission_pct:d.driver, rep_commission_pct:d.rep, rep_id: v === "driver_only" ? "" : quickExtra.rep_id }); };
        const cf = extraCfCalc(quickExtra);
        const a = isCf ? cf.total : numv(quickExtra.amount);
        const bsOn = !brokerShareMissing && !!quickExtra.broker_share_enabled;
        const bsPct = bsOn ? numv(quickExtra.broker_share_pct) : 0;
        const brokerShare = a * bsPct / 100;
        const netAmt = a - brokerShare;
        const commBaseVal = isCf ? cf.commissionBase : (quickExtra.commission_base === "net" ? "net" : "gross");
        const base = isCf ? cf.base : (commBaseVal === "net" ? netAmt : a);
        const dc = base * numv(quickExtra.driver_commission_pct) / 100, rc = base * numv(quickExtra.rep_commission_pct) / 100;
        return (
          <Modal title={quickExtra.id ? "Edit extra" : "Add extra"} onClose={() => setQuickExtra(null)}
            footer={<>
              <Btn onClick={() => setQuickExtra(null)}>Cancel</Btn>
              <Btn primary disabled={!quickExtra.driver_id || (needsJob && !quickExtra.jobId)} onClick={saveQuickExtra}>{quickExtra.id ? "Save changes" : "Save extra"}</Btn>
            </>}>
            {needsJob && (
              <div style={{ marginBottom:10 }}>
                <Field label="Job *">
                  {exSelected ? (
                    <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      <span style={{ fontFamily:"monospace", fontWeight:700 }}>{exSelected.job_number || "(no #)"}</span>
                      <span style={{ fontSize:12, color:"#666" }}>{exSelected.customer || "—"}</span>
                      <button onClick={() => setQ({ jobId:"" })} style={{ border:"none", background:"none", cursor:"pointer", color:"#999", fontSize:12, textDecoration:"underline" }}>cambiar</button>
                    </div>
                  ) : (
                    <>
                      <input style={inp} value={extraJobSearch} onChange={e => setExtraJobSearch(e.target.value)} placeholder="Search by job # or client…" />
                      {exQ && (
                        <div style={{ border:"1px solid #f0f0f0", borderRadius:8, marginTop:6, maxHeight:160, overflowY:"auto" }}>
                          {exMatches.length === 0 ? <div style={{ padding:"10px", fontSize:12, color:"#bbb" }}>No results.</div>
                            : exMatches.map(g => (
                              <button key={g.key} onClick={() => pickJob(g)} style={{ display:"block", width:"100%", textAlign:"left", padding:"7px 10px", border:"none", borderBottom:"1px solid #f6f6f6", background:"#fff", cursor:"pointer", fontSize:12.5 }}>
                                <span style={{ fontFamily:"monospace", fontWeight:600 }}>{g.job_number || "(no #)"}</span> · {g.customer || "—"}
                              </button>
                            ))}
                        </div>
                      )}
                    </>
                  )}
                </Field>
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <Field label="Type">
                <select style={inp} value={quickExtra.extra_type} onChange={e => onType(e.target.value)}>
                  {EXTRA_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                </select>
              </Field>
              {!isCf && <Field label="Amount ($)"><input style={inp} type="number" value={quickExtra.amount} onChange={e => setQ({ amount:e.target.value })} placeholder="0" /></Field>}
              {quickExtra.extra_type === "other" && <Field label="Description" full><input style={inp} value={quickExtra.description} onChange={e => setQ({ description:e.target.value })} placeholder="Extra detail" /></Field>}
              <Field label="Generated by">
                <select style={inp} value={quickExtra.generated_by} disabled={locked} onChange={e => onGen(e.target.value)}>
                  {GEN_BY.map(g => <option key={g.v} value={g.v}>{g.l}</option>)}
                </select>
              </Field>
              <Field label="Driver *">
                <select style={{ ...inp, borderColor: quickExtra.driver_id ? "#e5e5e5" : "#fca5a5" }} value={quickExtra.driver_id} onChange={e => setQ({ driver_id:e.target.value })}>
                  <option value="">— Select —</option>
                  {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </Field>
              {quickExtra.generated_by !== "driver_only" && (
                <Field label="Rep">
                  <select style={inp} value={quickExtra.rep_id} onChange={e => setQ({ rep_id:e.target.value })}>
                    <option value="">— Select —</option>
                    {employees.map(em => <option key={em.id} value={em.id}>{em.name}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Driver %"><input style={inp} type="number" value={quickExtra.driver_commission_pct} onChange={e => setQ({ driver_commission_pct:e.target.value })} /></Field>
              <Field label="Rep %"><input style={inp} type="number" value={quickExtra.rep_commission_pct} onChange={e => setQ({ rep_commission_pct:e.target.value })} /></Field>
            </div>

            {/* Extra CF: CF × rate + fuel surcharge + commission base */}
            {isCf && (
              <div style={{ marginTop:10, padding:"10px 12px", background:"#F2F7FC", border:"1px solid #D6E6F5", borderRadius:9 }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                  <Field label="Extra CF count"><input style={inp} type="number" value={quickExtra.extra_cf_count} onChange={e => setQ({ extra_cf_count:e.target.value })} placeholder="0" /></Field>
                  <Field label="Rate per CF ($)"><input style={inp} type="number" value={quickExtra.extra_cf_rate} onChange={e => setQ({ extra_cf_rate:e.target.value })} placeholder="0" /></Field>
                  <Field label="CF subtotal"><input style={{ ...inp, background:"#f3f3f3", color:"#666" }} value={money(cf.cfSub) || "$0"} readOnly /></Field>
                  <Field label="Fuel surcharge %"><input style={inp} type="number" value={quickExtra.fuel_surcharge_pct} onChange={e => setQ({ fuel_surcharge_pct:e.target.value })} placeholder="0" /></Field>
                  <Field label="Fuel surcharge amount"><input style={{ ...inp, background:"#f3f3f3", color:"#666" }} value={money(cf.fuelAmt) || "$0"} readOnly /></Field>
                  <Field label="Total charged"><input style={{ ...inp, background:"#f3f3f3", fontWeight:700 }} value={money(cf.total) || "$0"} readOnly /></Field>
                </div>
                <div style={{ marginTop:10 }}>
                  <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:5 }}>Commission base</div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                    {[["with_fuel", "With fuel surcharge", cf.total], ["without_fuel", "No fuel surcharge", cf.cfSub]].map(([v, l, amt]) => {
                      const on = cf.commissionBase === v;
                      return <button key={v} onClick={() => setQ({ commission_base: v })} style={{ flex:1, minWidth:140, textAlign:"left", padding:"8px 11px", borderRadius:8, cursor:"pointer", border:`1px solid ${on ? "#185FA5" : "#e5e5e5"}`, background: on ? "#E6F1FB" : "#fff", color:"#111" }}>
                        <div style={{ fontSize:12.5, fontWeight:600 }}>{on ? "◉" : "○"} {l}</div>
                        <div style={{ fontSize:11, color:"#888", marginTop:2 }}>Commission on {money(amt) || "$0"}</div>
                      </button>;
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Broker share (collapsible) */}
            {!brokerShareMissing && (
              <div style={{ marginTop:10, padding:"10px 12px", background:"#FFF8F0", border:"1px solid #FAE6CF", borderRadius:9 }}>
                <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer", fontWeight:600 }}>
                  <input type="checkbox" checked={bsOn} onChange={e => setQ({ broker_share_enabled: e.target.checked, broker_share_pct: e.target.checked && (quickExtra.broker_share_pct === "" || quickExtra.broker_share_pct == null) ? "" : quickExtra.broker_share_pct })} />
                  🤝 El broker se queda con un % de este extra
                </label>
                {bsOn && (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginTop:10 }}>
                    <Field label="Broker share %"><input style={inp} type="number" value={quickExtra.broker_share_pct} onChange={e => setQ({ broker_share_pct:e.target.value })} placeholder="0" /></Field>
                    <Field label="Broker share amount"><input style={{ ...inp, background:"#f3f3f3", color:"#666" }} value={money(brokerShare) || "$0"} readOnly /></Field>
                    <Field label="Net amount"><input style={{ ...inp, background:"#f3f3f3", fontWeight:700 }} value={money(netAmt) || "$0"} readOnly /></Field>
                  </div>
                )}
              </div>
            )}

            {/* Commission base selector (gross vs net) — only for non-CF when broker share applies */}
            {!isCf && bsOn && bsPct > 0 && (
              <div style={{ marginTop:10 }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:5 }}>Commission base</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {[["gross", "On the gross amount", a], ["net", "On the net (post broker)", netAmt]].map(([v, l, amt]) => {
                    const on = commBaseVal === v;
                    return <button key={v} onClick={() => setQ({ commission_base: v })} style={{ flex:1, minWidth:150, textAlign:"left", padding:"8px 11px", borderRadius:8, cursor:"pointer", border:`1px solid ${on ? "#185FA5" : "#e5e5e5"}`, background: on ? "#E6F1FB" : "#fff", color:"#111" }}>
                      <div style={{ fontSize:12.5, fontWeight:600 }}>{on ? "◉" : "○"} {l}</div>
                      <div style={{ fontSize:11, color:"#888", marginTop:2 }}>Commission on {money(amt) || "$0"}</div>
                    </button>;
                  })}
                </div>
              </div>
            )}

            <div style={{ marginTop:12, background:"#fafafa", borderRadius:8, padding:"9px 12px", fontSize:12.5 }}>
              <div style={{ marginBottom:5, color:"#666" }}>Commission base: <b>{money(base) || "$0"}</b>{isCf ? ` (${cf.commissionBase === "without_fuel" ? "without" : "with"} fuel)` : bsPct > 0 ? ` (${commBaseVal === "net" ? "net" : "gross"})` : ""}</div>
              <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                <span>Driver commission ({numv(quickExtra.driver_commission_pct)}%): <b style={{ color:"#1A8A4E" }}>{money(dc) || "$0"}</b></span>
                <span>Rep commission ({numv(quickExtra.rep_commission_pct)}%): <b style={{ color:"#185FA5" }}>{money(rc) || "$0"}</b></span>
                {bsPct > 0 && <span>Broker share: <b style={{ color:"#C2410C" }}>{money(brokerShare) || "$0"}</b></span>}
                <span>Net to company: <b style={{ color:"#EF9F27" }}>{money(netAmt - dc - rc) || "$0"}</b></span>
              </div>
            </div>
          </Modal>
        );
      })()}

      {showPayModal && (() => {
        const groups = [...extraJobGroups.values()];
        const q = payJobSearch.trim().toLowerCase();
        const matches = (q ? groups.filter(g => (g.job_number || "").toLowerCase().includes(q) || (g.customer || "").toLowerCase().includes(q)) : groups).slice(0, 40);
        const selectedG = payForm.job_id ? groups.find(g => String(g.repId) === String(payForm.job_id) || g.ids.includes(Number(payForm.job_id))) : null;
        const digital = isDigitalMethod(payForm.method);
        const physical = isPhysical(payForm.method);
        const setF = (fields) => setPayForm(f => ({ ...f, ...fields }));
        const net = numv(payForm.amount) - numv(payForm.discount);
        const whoList = [...driversList.map(d => d.name), ...employees.map(e => e.name)].filter(Boolean);
        // Split-payment helpers (only available when creating, with columns present).
        const canSplit = (!editingPayId || !!reallocPay) && !splitMissing;
        const splitOn = canSplit && payForm.split_enabled;
        const splitLines = payForm.split_lines || [];
        const splitSum = splitLines.reduce((s, l) => s + numv(l.amount), 0);
        const splitMatches = Math.abs(splitSum - numv(payForm.amount)) < 0.01;
        const setLines = (lines) => setF({ split_lines: lines });
        const patchLine = (i, fields) => setLines(splitLines.map((l, ix) => ix === i ? { ...l, ...fields } : l));
        // Charge-allocation mode: split against the job's real outstanding charges.
        const allocOn = splitOn && !allocMissing && payForm.job_id && Array.isArray(payForm.alloc_lines);
        const allocLines = payForm.alloc_lines || [];
        const allocTotal = numv(reallocPay ? reallocPay.amount : payForm.amount);
        const allocState = allocOn ? serializeAllocLines(allocLines, allocTotal) : null;
        const patchAlloc = (i, fields) => setF({ alloc_lines: allocLines.map((l, ix) => ix === i ? { ...l, ...fields, touched: true } : l) });
        // Re-seed the proposal while the user hasn't touched any line.
        const onAmountChange = (v) => {
          const fields = { amount: v };
          if (allocOn && !allocLines.some(l => l.touched)) fields.alloc_lines = seedAllocLines(payForm.job_id, v);
          setF(fields);
        };
        const saveDisabled = paySaving || (reallocPay ? (!allocState || !!allocState.error || !allocState.rows.length)
          : (payForm.amount === "" || (allocOn ? !!allocState.error : (splitOn && (!splitMatches || splitLines.every(l => l.amount === ""))))));
        return (
          <Modal title={reallocPay ? "Asignar pago a cuenta" : editingPayId ? "Edit payment" : "New payment"} onClose={() => { setShowPayModal(false); setReallocPay(null); }}
            footer={<>
              <Btn onClick={() => { setShowPayModal(false); setReallocPay(null); }}>Cancel</Btn>
              <Btn primary disabled={saveDisabled} onClick={savePaymentRow}>{paySaving ? "Saving..." : (reallocPay ? "Asignar" : editingPayId ? "Save changes" : splitOn ? (allocOn ? "Create payment" : "Create split payments") : "Create payment")}</Btn>
            </>}>
            <Field label="Job">
              {selectedG ? (
                <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                  <span style={{ fontFamily:"monospace", fontWeight:700 }}>{selectedG.job_number || "(no #)"}</span>
                  <span style={{ fontSize:12, color:"#666" }}>{selectedG.customer || "—"}</span>
                  <button onClick={() => setF({ job_id:"" })} style={{ border:"none", background:"none", cursor:"pointer", color:"#999", fontSize:12, textDecoration:"underline" }}>cambiar</button>
                </div>
              ) : (
                <>
                  <input style={inp} value={payJobSearch} onChange={e => setPayJobSearch(e.target.value)} placeholder="Search by job # or client…" />
                  {q && (
                    <div style={{ border:"1px solid #f0f0f0", borderRadius:8, marginTop:6, maxHeight:160, overflowY:"auto" }}>
                      {matches.length === 0 ? <div style={{ padding:"10px", fontSize:12, color:"#bbb" }}>No results.</div>
                        : matches.map(g => (
                          <button key={g.key} onClick={() => {
                              const fields = { job_id: g.repId };
                              // Auto-arm charge allocation when the job has pending extras.
                              if (canSplit && !allocMissing && !editingPayId && jobWantsAllocation(g.repId)) {
                                fields.split_enabled = true;
                                fields.alloc_lines = seedAllocLines(g.repId, payForm.amount);
                              } else if (!editingPayId && !allocMissing) {
                                fields.alloc_lines = seedAllocLines(g.repId, payForm.amount);
                              }
                              setF(fields); setPayJobSearch("");
                            }} style={{ display:"block", width:"100%", textAlign:"left", padding:"7px 10px", border:"none", borderBottom:"1px solid #f6f6f6", background:"#fff", cursor:"pointer", fontSize:12.5 }}>
                            <span style={{ fontFamily:"monospace", fontWeight:600 }}>{g.job_number || "(no #)"}</span> · {g.customer || "—"}
                          </button>
                        ))}
                    </div>
                  )}
                </>
              )}
            </Field>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
              <Field label="Payment date"><input style={inp} type="date" value={payForm.payment_date} onChange={e => setF({ payment_date:e.target.value })} /></Field>
              <Field label={splitOn ? "Total amount ($) *" : "Amount ($) *"}><input style={inp} type="number" value={payForm.amount} disabled={!!reallocPay} onChange={e => onAmountChange(e.target.value)} placeholder="0" /></Field>
              {!splitOn && <Field label="Concept">
                <select style={inp} value={payForm.concept} onChange={e => setF({ concept:e.target.value })}>
                  {PAY_CONCEPTS.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
                </select>
              </Field>}
              {!splitOn && <Field label="Discount ($)"><input style={inp} type="number" value={payForm.discount} onChange={e => setF({ discount:e.target.value })} placeholder="0" /></Field>}
              {!splitOn && <Field label="Discount reason"><input style={inp} value={payForm.discount_reason} onChange={e => setF({ discount_reason:e.target.value })} placeholder="Reason" /></Field>}
              {!payStageMissing && <Field label="Payment stage">
                <select style={inp} value={payForm.payment_stage} onChange={e => setF({ payment_stage:e.target.value })}>
                  <option value="">— Select —</option>
                  <option value="pickup">At pick up</option>
                  <option value="delivery">At delivery</option>
                  <option value="other">Other</option>
                </select>
              </Field>}
            </div>

            {/* Split payment toggle + builder (charge allocation when possible) */}
            {canSplit && (
              <div style={{ marginTop:10 }}>
                {!reallocPay && (
                  <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer", fontWeight:600 }}>
                    <input type="checkbox" checked={!!payForm.split_enabled} onChange={e => {
                      const on = e.target.checked;
                      const fields = { split_enabled: on };
                      if (on && !allocMissing && payForm.job_id) fields.alloc_lines = payForm.alloc_lines || seedAllocLines(payForm.job_id, payForm.amount);
                      if (on && !fields.alloc_lines && !splitLines.length) fields.split_lines = [{ concept:"job", amount:"", notes:"" }];
                      setF(fields);
                    }} />
                    {!allocMissing && payForm.job_id ? "✂️ Asignar a cargos (split)" : "✂️ Split the payment"}
                  </label>
                )}
                {allocOn && (
                  <div style={{ marginTop:8, padding:"10px 12px", background:"#F6F4FC", border:"1px solid #E3DCF6", borderRadius:9 }}>
                    <div style={{ fontSize:11, color:"#6D28D9", marginBottom:8 }}>Repartí el pago entre el balance del job y los extras pendientes. Lo que no asignes queda <b>a cuenta</b>.</div>
                    {allocLines.map((l, i) => {
                      const entered = numv(l.amount);
                      const after = Math.max(0, l.remaining - entered);
                      const over = entered > l.remaining + 0.01;
                      return (
                        <div key={i} style={{ display:"flex", gap:8, alignItems:"center", marginBottom:7, flexWrap:"wrap" }}>
                          <div style={{ flex:"1 1 170px", minWidth:150 }}>
                            <div style={{ fontSize:12.5, fontWeight:600 }}>{l.kind === "custom" ? (
                              <select style={{ ...inp, padding:"5px 8px" }} value={l.concept} onChange={e => patchAlloc(i, { concept: e.target.value })}>
                                {SPLIT_CONCEPTS.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
                              </select>
                            ) : l.label}</div>
                            {l.kind !== "custom" && <div style={{ fontSize:10.5, color:"#888" }}>Pendiente: ${l.remaining.toLocaleString(undefined,{maximumFractionDigits:2})}</div>}
                          </div>
                          <input style={{ ...inp, flex:"0 0 100px", width:100 }} type="number" value={l.amount} onChange={e => patchAlloc(i, { amount: e.target.value })} placeholder="$" />
                          {l.kind !== "custom" && (
                            over
                              ? <span style={{ fontSize:11, color:"#C2410C", fontWeight:600 }}>Sobrepago ${ (entered - l.remaining).toLocaleString(undefined,{maximumFractionDigits:2}) } — se registra igual</span>
                              : <span style={{ fontSize:11, color: after > 0 ? "#92760B" : "#1A8A4E" }}>Restante: ${after.toLocaleString(undefined,{maximumFractionDigits:2})}</span>
                          )}
                          {l.kind === "custom" && (
                            <>
                              <input style={{ ...inp, flex:"1 1 120px", minWidth:110 }} value={l.notes} onChange={e => patchAlloc(i, { notes: e.target.value })} placeholder="Notes (optional)" />
                              <button onClick={() => setF({ alloc_lines: allocLines.filter((_, ix) => ix !== i) })} title="Remove line" style={{ border:"none", background:"none", cursor:"pointer", color:"#E24B4A", fontSize:18, lineHeight:1, padding:"6px 4px" }}>×</button>
                            </>
                          )}
                        </div>
                      );
                    })}
                    <button onClick={() => setF({ alloc_lines: [...allocLines, { kind:"custom", concept:"packing", amount:"", notes:"", touched:true }] })} style={{ fontSize:12, fontWeight:600, color:"#6D28D9", border:"1px dashed #C4B5FD", background:"#fff", borderRadius:7, padding:"6px 11px", cursor:"pointer" }}>+ Nuevo extra / otra línea</button>
                    {(() => {
                      const st = allocState || { unassigned: 0, error: null };
                      return (
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10, paddingTop:8, borderTop:"1px solid #E3DCF6", fontSize:13, fontWeight:700 }}>
                          <span style={{ color:"#666" }}>Sin asignar (a cuenta): <b style={{ color: st.error ? "#E24B4A" : st.unassigned > 0 ? "#92760B" : "#1A8A4E" }}>${(st.error ? 0 : st.unassigned).toLocaleString(undefined,{maximumFractionDigits:2})}</b> <span style={{ fontWeight:400, color:"#999" }}>/ Total: ${allocTotal.toLocaleString(undefined,{maximumFractionDigits:2})}</span></span>
                          {st.error ? <span style={{ color:"#E24B4A" }}>✗ {st.error}</span> : <span style={{ color:"#1A8A4E" }}>✓</span>}
                        </div>
                      );
                    })()}
                  </div>
                )}
                {splitOn && !allocOn && (
                  <div style={{ marginTop:8, padding:"10px 12px", background:"#F6F4FC", border:"1px solid #E3DCF6", borderRadius:9 }}>
                    <div style={{ fontSize:11, color:"#6D28D9", marginBottom:8 }}>Split the total amount into concepts. Extra lines are recorded automatically for commissions.</div>
                    {splitLines.map((l, i) => (
                      <div key={i} style={{ display:"flex", gap:6, alignItems:"flex-start", marginBottom:7, flexWrap:"wrap" }}>
                        <select style={{ ...inp, flex:"1 1 130px", minWidth:120 }} value={l.concept} onChange={e => patchLine(i, { concept: e.target.value })}>
                          {SPLIT_CONCEPTS.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
                        </select>
                        <input style={{ ...inp, flex:"0 0 100px", width:100 }} type="number" value={l.amount} onChange={e => patchLine(i, { amount: e.target.value })} placeholder="$" />
                        <input style={{ ...inp, flex:"1 1 130px", minWidth:120 }} value={l.notes} onChange={e => patchLine(i, { notes: e.target.value })} placeholder="Notes (optional)" />
                        <button onClick={() => setLines(splitLines.filter((_, ix) => ix !== i))} disabled={splitLines.length <= 1} title="Remove line" style={{ border:"none", background:"none", cursor: splitLines.length <= 1 ? "not-allowed" : "pointer", color: splitLines.length <= 1 ? "#ddd" : "#E24B4A", fontSize:18, lineHeight:1, padding:"6px 4px" }}>×</button>
                      </div>
                    ))}
                    <button onClick={() => setLines([...splitLines, { concept:"job", amount:"", notes:"" }])} style={{ fontSize:12, fontWeight:600, color:"#6D28D9", border:"1px dashed #C4B5FD", background:"#fff", borderRadius:7, padding:"6px 11px", cursor:"pointer" }}>+ Add line</button>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10, paddingTop:8, borderTop:"1px solid #E3DCF6", fontSize:13, fontWeight:700 }}>
                      <span style={{ color:"#666" }}>Split total: <b style={{ color: splitMatches ? "#1A8A4E" : "#E24B4A" }}>${splitSum.toLocaleString(undefined, { maximumFractionDigits:2 })}</b> <span style={{ fontWeight:400, color:"#999" }}>/ Total: ${numv(payForm.amount).toLocaleString(undefined, { maximumFractionDigits:2 })}</span></span>
                      <span style={{ color: splitMatches ? "#1A8A4E" : "#E24B4A" }}>{splitMatches ? "✓ matches" : `✗ difiere $${Math.abs(splitSum - numv(payForm.amount)).toLocaleString(undefined, { maximumFractionDigits:2 })}`}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Method pill tabs */}
            <div style={{ marginTop:12 }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Method</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {PAY_METHODS.map(pm => {
                  const on = payForm.method === pm.v;
                  const hex = PAY_METHOD_META[pm.v] || "#666";
                  return <button key={pm.v} onClick={() => setF({ method: pm.v })} style={{ fontSize:12, fontWeight:600, padding:"6px 12px", borderRadius:20, cursor:"pointer", border:`1px solid ${on ? hex : "#e5e5e5"}`, background: on ? hex+"1a" : "#fff", color: on ? hex : "#666" }}>{pm.l}</button>;
                })}
              </div>
            </div>

            {payColsMissing && (
              <div style={{ marginTop:8, fontSize:11.5, color:"#854F0B", background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:8, padding:"6px 10px" }}>
                Run the updated SQL to save check / money order / CC fee details. <button onClick={() => setShowSetup(true)} style={{ border:"none", background:"none", color:"#854F0B", textDecoration:"underline", cursor:"pointer", fontSize:11.5 }}>View SQL</button>
              </div>
            )}

            {/* CHECK details */}
            {payForm.method === "check" && !payColsMissing && (() => {
              const ck = payForm.check_type;
              const isPersonal = ck === "personal_check";
              return (
                <div style={{ marginTop:10, padding:"10px 12px", background:"#F2F7FC", border:"1px solid #D6E6F5", borderRadius:9 }}>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}>
                    {CHECK_TYPES.map(t => { const on = ck === t.v; return <button key={t.v} onClick={() => setF({ check_type: t.v })} style={{ fontSize:12, fontWeight:600, padding:"5px 11px", borderRadius:20, cursor:"pointer", border:`1px solid ${on ? "#185FA5" : "#cfe0f0"}`, background: on ? "#185FA5" : "#fff", color: on ? "#fff" : "#185FA5" }}>{t.l}</button>; })}
                  </div>
                  {!ck ? <div style={{ fontSize:12, color:"#888" }}>Choose the check type.</div> : isPersonal ? (
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      <Field label="Check number (serial)">
                        <input style={inp} value={payForm.check_serial} onChange={e => setF({ check_serial:e.target.value })} placeholder="N°" />
                        <DupHint checking={chkSerialChecking && (payForm.check_serial || "").trim() !== ""} tone="danger">
                          {checkSerialDup && <span>⚠️ Check #{checkSerialDup.serial} already recorded — ${Math.round(checkSerialDup.amount).toLocaleString()} el {checkSerialDup.date}, job {checkSerialDup.job_number}.{checkSerialDup.job_key && <> <a onClick={() => { setShowPayModal(false); setJobDetailKey(checkSerialDup.job_key); }} style={{ cursor:"pointer", textDecoration:"underline", fontWeight:700 }}>Ver pago</a></>}</span>}
                        </DupHint>
                      </Field>
                      <Field label="From (titular)"><input style={inp} value={payForm.check_from} onChange={e => setF({ check_from:e.target.value })} placeholder="Account holder" /></Field>
                      <Field label="Bank name"><input style={inp} value={payForm.check_bank} onChange={e => setF({ check_bank:e.target.value })} placeholder="Banco" /></Field>
                      <Field label="Date on check"><input style={inp} type="date" value={payForm.check_date} onChange={e => setF({ check_date:e.target.value })} /></Field>
                      <Field label="Routing (opcional)"><input style={inp} value={payForm.check_routing} onChange={e => setF({ check_routing:e.target.value })} placeholder="Routing" /></Field>
                      <Field label="Account last 4 (opcional)"><input style={inp} maxLength={4} value={payForm.check_account_last4} onChange={e => setF({ check_account_last4:e.target.value })} placeholder="1234" /></Field>
                      <Field label="Memo" full><input style={inp} value={payForm.check_memo} onChange={e => setF({ check_memo:e.target.value })} placeholder="Memo" /></Field>
                    </div>
                  ) : (
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      <Field label="Check number (serial)">
                        <input style={inp} value={payForm.check_serial} onChange={e => setF({ check_serial:e.target.value })} placeholder="N°" />
                        <DupHint checking={chkSerialChecking && (payForm.check_serial || "").trim() !== ""} tone="danger">
                          {checkSerialDup && <span>⚠️ Check #{checkSerialDup.serial} already recorded — ${Math.round(checkSerialDup.amount).toLocaleString()} el {checkSerialDup.date}, job {checkSerialDup.job_number}.{checkSerialDup.job_key && <> <a onClick={() => { setShowPayModal(false); setJobDetailKey(checkSerialDup.job_key); }} style={{ cursor:"pointer", textDecoration:"underline", fontWeight:700 }}>Ver pago</a></>}</span>}
                        </DupHint>
                      </Field>
                      <Field label="Transaction number"><input style={inp} value={payForm.check_transaction_number} onChange={e => setF({ check_transaction_number:e.target.value })} placeholder="Transaction #" /></Field>
                      <Field label="Remitter (who bought it)"><input style={inp} value={payForm.check_remitter} onChange={e => setF({ check_remitter:e.target.value })} placeholder="Remitter" /></Field>
                      <Field label="Purchased by"><input style={inp} value={payForm.check_purchased_by} onChange={e => setF({ check_purchased_by:e.target.value })} placeholder="Comprador" /></Field>
                      <Field label="Bank / Issuer">
                        <select style={inp} value={payForm.check_bank} onChange={e => setF({ check_bank:e.target.value })}>
                          <option value="">— Select —</option>
                          {CHECK_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </Field>
                      <Field label="Date on check"><input style={inp} type="date" value={payForm.check_date} onChange={e => setF({ check_date:e.target.value })} /></Field>
                      <Field label="Memo" full><input style={inp} value={payForm.check_memo} onChange={e => setF({ check_memo:e.target.value })} placeholder="Memo" /></Field>
                    </div>
                  )}
                  {ck && <PayPhotoBox url={payForm.check_photo_url} uploading={payDocUploading} onFile={(f) => uploadPaymentDoc(f, "check_photo_url")} label="Check photo" />}
                </div>
              );
            })()}

            {/* MONEY ORDER details */}
            {payForm.method === "money_order" && !payColsMissing && (() => {
              const isUsps = payForm.mo_type === "usps";
              return (
                <div style={{ marginTop:10, padding:"10px 12px", background:"#F1FAFB", border:"1px solid #CFE9EC", borderRadius:9 }}>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}>
                    {MO_TYPES.map(t => { const on = payForm.mo_type === t.v; return <button key={t.v} onClick={() => setF({ mo_type: t.v })} style={{ fontSize:12, fontWeight:600, padding:"5px 11px", borderRadius:20, cursor:"pointer", border:`1px solid ${on ? "#0E7490" : "#CFE9EC"}`, background: on ? "#0E7490" : "#fff", color: on ? "#fff" : "#0E7490" }}>{t.l}</button>; })}
                  </div>
                  {isUsps ? (
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      <Field label="Serial number">
                        <input style={inp} value={payForm.mo_serial} onChange={e => setF({ mo_serial:e.target.value })} placeholder="Serial" />
                        <DupHint checking={moSerialChecking && (payForm.mo_serial || "").trim() !== ""} tone="danger">
                          {moSerialDup && <span>⚠️ MO #{moSerialDup.serial} already recorded — ${Math.round(moSerialDup.amount).toLocaleString()} el {moSerialDup.date}, job {moSerialDup.job_number}.{moSerialDup.job_key && <> <a onClick={() => { setShowPayModal(false); setJobDetailKey(moSerialDup.job_key); }} style={{ cursor:"pointer", textDecoration:"underline", fontWeight:700 }}>Ver pago</a></>}</span>}
                        </DupHint>
                      </Field>
                      <Field label="Date"><input style={inp} type="date" value={payForm.mo_date} onChange={e => setF({ mo_date:e.target.value })} /></Field>
                      <Field label="Post office #"><input style={inp} value={payForm.mo_post_office} onChange={e => setF({ mo_post_office:e.target.value })} placeholder="Post office" /></Field>
                      <Field label="From name"><input style={inp} value={payForm.mo_from_name} onChange={e => setF({ mo_from_name:e.target.value })} placeholder="From" /></Field>
                      <Field label="From address" full><input style={inp} value={payForm.mo_from_address} onChange={e => setF({ mo_from_address:e.target.value })} placeholder="Address" /></Field>
                    </div>
                  ) : (
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      <Field label="Serial number">
                        <input style={inp} value={payForm.mo_serial} onChange={e => setF({ mo_serial:e.target.value })} placeholder="Serial" />
                        <DupHint checking={moSerialChecking && (payForm.mo_serial || "").trim() !== ""} tone="danger">
                          {moSerialDup && <span>⚠️ MO #{moSerialDup.serial} already recorded — ${Math.round(moSerialDup.amount).toLocaleString()} el {moSerialDup.date}, job {moSerialDup.job_number}.{moSerialDup.job_key && <> <a onClick={() => { setShowPayModal(false); setJobDetailKey(moSerialDup.job_key); }} style={{ cursor:"pointer", textDecoration:"underline", fontWeight:700 }}>Ver pago</a></>}</span>}
                        </DupHint>
                      </Field>
                      <Field label="Date"><input style={inp} type="date" value={payForm.mo_date} onChange={e => setF({ mo_date:e.target.value })} /></Field>
                      <Field label="Purchaser name"><input style={inp} value={payForm.mo_from_name} onChange={e => setF({ mo_from_name:e.target.value })} placeholder="Comprador" /></Field>
                      <Field label="Pay to the order of"><input style={inp} value={payForm.mo_from_address} onChange={e => setF({ mo_from_address:e.target.value })} placeholder="Pay to…" /></Field>
                      <Field label="Payment for / Acct #"><input style={inp} value={payForm.mo_payment_for} onChange={e => setF({ mo_payment_for:e.target.value })} placeholder="Payment for / Acct" /></Field>
                      <Field label="Issuer location"><input style={inp} value={payForm.mo_issuer_location} onChange={e => setF({ mo_issuer_location:e.target.value })} placeholder="Location" /></Field>
                    </div>
                  )}
                  <PayPhotoBox url={payForm.mo_photo_url} uploading={payDocUploading} onFile={(f) => uploadPaymentDoc(f, "mo_photo_url")} label="Money order photo" />
                </div>
              );
            })()}

            {/* CREDIT CARD fee */}
            {payForm.method === "credit_card" && !payColsMissing && !splitOn && (() => {
              const amt = numv(payForm.amount), pct = numv(payForm.cc_fee_pct), fee = payForm.cc_fee_enabled ? (amt * pct / 100) : 0;
              return (
                <div style={{ marginTop:10, padding:"10px 12px", background:"#FFF6EC", border:"1px solid #F4DDB0", borderRadius:9 }}>
                  <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer", fontWeight:600 }}>
                    <input type="checkbox" checked={!!payForm.cc_fee_enabled} onChange={e => setF({ cc_fee_enabled: e.target.checked })} />
                    Charge CC fee to client
                  </label>
                  {payForm.cc_fee_enabled && (
                    <>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginTop:10 }}>
                        <Field label="Payment amount ($)"><input style={{ ...inp, background:"#f3f3f3" }} type="number" value={payForm.amount} readOnly /></Field>
                        <Field label="CC fee %"><input style={inp} type="number" value={payForm.cc_fee_pct} onChange={e => setF({ cc_fee_pct:e.target.value })} /></Field>
                        <Field label="CC fee amount"><input style={{ ...inp, background:"#f3f3f3" }} value={fee ? `$${fee.toLocaleString(undefined, { maximumFractionDigits:2 })}` : "$0"} readOnly /></Field>
                      </div>
                      <div style={{ marginTop:10, background:"#fff", border:"1px solid #f0e0c0", borderRadius:8, padding:"8px 11px", fontSize:12.5 }}>
                        <div style={{ display:"flex", justifyContent:"space-between" }}><span>Payment amount</span><b>${amt.toLocaleString()}</b></div>
                        <div style={{ display:"flex", justifyContent:"space-between" }}><span>+ CC fee ({pct}%)</span><b style={{ color:"#854F0B" }}>${fee.toLocaleString(undefined, { maximumFractionDigits:2 })}</b></div>
                        <div style={{ display:"flex", justifyContent:"space-between", borderTop:"1px solid #f0e0c0", marginTop:5, paddingTop:5, fontWeight:800 }}><span>Total to collect</span><span style={{ color:"#1A8A4E" }}>${(amt + fee).toLocaleString(undefined, { maximumFractionDigits:2 })}</span></div>
                      </div>
                      <div style={{ fontSize:11, color:"#999", marginTop:6 }}>Se crea un pago separado con concepto <b>CC Fee</b> al guardar.</div>
                    </>
                  )}
                </div>
              );
            })()}

            <div style={{ marginTop:10, padding:"10px 12px", background:"#fafafa", borderRadius:8 }}>
              <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer" }}>
                <input type="checkbox" checked={digital ? true : payForm.received} disabled={digital} onChange={e => setF({ received:e.target.checked })} />
                <b>Received</b>{digital && <span style={{ fontSize:11, color:"#888" }}>(automatic for digital payments)</span>}
              </label>
              {(digital || payForm.received) && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:8 }}>
                  <Field label="Received by">
                    <input style={inp} list="who-list" value={payForm.received_by} onChange={e => setF({ received_by:e.target.value })} placeholder="Driver / rep" />
                  </Field>
                  <Field label="Received date"><input style={inp} type="date" value={payForm.received_date} onChange={e => setF({ received_date:e.target.value })} /></Field>
                </div>
              )}
            </div>

            {physical && (
              <div style={{ marginTop:10, padding:"10px 12px", background:"#FFF8F0", borderRadius:8, border:"1px solid #FAE6CF" }}>
                <Field label="Who has the money?">
                  <input style={inp} list="who-list" value={payForm.cash_with_whom} onChange={e => setF({ cash_with_whom:e.target.value })} placeholder="Person holding the cash/check" />
                </Field>
                <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer", marginTop:10 }}>
                  <input type="checkbox" checked={payForm.banked} onChange={e => setF({ banked:e.target.checked })} />
                  <b>Deposited</b>
                </label>
                {payForm.banked && (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:8 }}>
                    <Field label="Deposit date"><input style={inp} type="date" value={payForm.banked_date} onChange={e => setF({ banked_date:e.target.value })} /></Field>
                    <Field label="Bank account">
                      <select style={inp} value={payForm.bank_account} onChange={e => setF({ bank_account:e.target.value })}>
                        <option value="">— Select —</option>
                        {payAccounts.filter(a => a.active !== false || a.name === payForm.bank_account).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
              </div>
            )}
            {digital && (
              <div style={{ marginTop:10, padding:"8px 12px", background:"#E6F1FB", borderRadius:8, fontSize:12.5, color:"#185FA5" }}>
                💳 Digital payment — automatically marked as deposited.
                <div style={{ marginTop:6 }}>
                  <select style={{ ...inp, width:"auto" }} value={payForm.bank_account} onChange={e => setF({ bank_account:e.target.value })}>
                    <option value="">— Account (optional) —</option>
                    {payAccounts.filter(a => a.active !== false || a.name === payForm.bank_account).map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                  </select>
                </div>
              </div>
            )}
            <Field label="Notes" full><input style={{ ...inp, marginTop:10 }} value={payForm.notes} onChange={e => setF({ notes:e.target.value })} placeholder="Notes" /></Field>
            <div style={{ marginTop:10, fontSize:13, textAlign:"right", color:"#666" }}>Net: <b style={{ color:"#1A8A4E" }}>${net.toLocaleString()}</b></div>
            <datalist id="who-list">{whoList.map((n, i) => <option key={i} value={n} />)}</datalist>
          </Modal>
        );
      })()}

      {/* ── Bank accounts manager (payment_accounts) ── */}
      {showAccountsModal && (
        <Modal title="Bank accounts" onClose={() => { setShowAccountsModal(false); setAccountFormOpen(false); }}
          footer={<>
            <Btn onClick={() => { setShowAccountsModal(false); setAccountFormOpen(false); }}>Close</Btn>
            {accountFormOpen && <Btn primary disabled={accountSaving || !accountForm.name.trim()} onClick={savePayAccount}>{accountSaving ? "Saving..." : (editingAccountId ? "Save changes" : "Add account")}</Btn>}
          </>}>
          {payAccounts.length === 0
            ? <div style={{ fontSize:13, color:"#bbb", padding:"4px 0 10px" }}>Sin cuentas todavía.</div>
            : payAccounts.map(a => (
                <div key={a.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:"1px solid #f0f0f0", fontSize:13, flexWrap:"wrap", opacity: a.active === false ? 0.55 : 1 }}>
                  <span style={{ fontWeight:600 }}>{a.name}</span>
                  {a.bank_name && <span style={{ fontSize:12, color:"#888" }}>{a.bank_name}</span>}
                  {a.account_type && <span style={{ fontSize:10.5, fontWeight:600, color:"#185FA5", background:"#E6F1FB", borderRadius:20, padding:"1px 8px" }}>{a.account_type}</span>}
                  {a.account_last4 && <span style={{ fontFamily:"monospace", fontSize:12, color:"#888" }}>••{a.account_last4}</span>}
                  {a.active === false && <span style={{ fontSize:10.5, fontWeight:700, color:"#999", background:"#F1F1F1", borderRadius:20, padding:"1px 8px" }}>Inactive</span>}
                  <span style={{ flex:1 }} />
                  <button onClick={() => openEditAccount(a)} title="Edit" style={{ border:"none", background:"none", cursor:"pointer", color:"#185FA5", fontSize:13 }}>✏️</button>
                  <button onClick={() => toggleAccountActive(a)} style={{ border:"1px solid #ddd", background:"#fff", cursor:"pointer", fontSize:11, borderRadius:7, padding:"3px 9px", color:"#555" }}>{a.active === false ? "Activate" : "Deactivate"}</button>
                  <button onClick={() => deletePayAccount(a)} title="Delete" style={{ border:"none", background:"none", cursor:"pointer", color:"#ccc", fontSize:16, lineHeight:1 }}>×</button>
                </div>
              ))}
          {accountFormOpen ? (
            <div style={{ marginTop:14, padding:"12px 14px", background:"#fafafa", borderRadius:9 }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>{editingAccountId ? "Edit account" : "New account"}</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <Field label="Name" full><input style={inp} value={accountForm.name} onChange={e => setAccountForm(f => ({ ...f, name:e.target.value }))} placeholder="ej: Chase Operations" /></Field>
                <Field label="Bank"><input style={inp} value={accountForm.bank_name} onChange={e => setAccountForm(f => ({ ...f, bank_name:e.target.value }))} placeholder="ej: Chase" /></Field>
                <Field label="Account type"><input style={inp} value={accountForm.account_type} onChange={e => setAccountForm(f => ({ ...f, account_type:e.target.value }))} placeholder="checking / savings" /></Field>
                <Field label="Last 4 digits"><input style={inp} value={accountForm.account_last4} onChange={e => setAccountForm(f => ({ ...f, account_last4:e.target.value.replace(/\D/g, "").slice(0, 4) }))} placeholder="1234" /></Field>
                <Field label="Status">
                  <select style={inp} value={accountForm.active ? "yes" : "no"} onChange={e => setAccountForm(f => ({ ...f, active: e.target.value === "yes" }))}>
                    <option value="yes">Active</option><option value="no">Inactive</option>
                  </select>
                </Field>
                <Field label="Notes" full><input style={inp} value={accountForm.notes} onChange={e => setAccountForm(f => ({ ...f, notes:e.target.value }))} placeholder="Notes" /></Field>
              </div>
              <div style={{ marginTop:8, textAlign:"right" }}>
                <button onClick={() => { setAccountFormOpen(false); setEditingAccountId(null); }} style={{ border:"none", background:"none", cursor:"pointer", fontSize:12, color:"#888", textDecoration:"underline" }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop:12 }}><Btn primary onClick={openAddAccount} style={{ padding:"6px 14px", fontSize:12.5 }}>+ Add account</Btn></div>
          )}
        </Modal>
      )}

      {/* ── Commission assignment for a payment-split extra ── */}
      {commAssign && (() => {
        const ca = commAssign;
        const ex = ca.extra;
        const k = jobKeyByRowId[ex.job_id];
        const g = k ? extraJobGroups.get(k) : null;
        const locked = EXTRA_LOCKED_DRIVER(ex.extra_type);
        const base = numv(ex.amount);
        const dPct = numv(ca.driver_pct), rPct = numv(ca.rep_pct);
        const dc = base * dPct / 100, rc = base * rPct / 100;
        const setCA = (fields) => setCommAssign(c => ({ ...c, ...fields }));
        const onGen = (v) => { const d = commissionDefaults(ex.extra_type, v); setCA({ generated_by: v, driver_pct: String(d.driver), rep_pct: String(d.rep), rep_id: v === "driver_only" ? "" : ca.rep_id }); };
        const remaining = ca.queue.length;
        return (
          <Modal title="Assign commission" onClose={() => setCommAssign(null)}
            footer={<>
              <Btn onClick={advanceCommQueue}>Skip{remaining ? ` (${remaining} more)` : ""}</Btn>
              <Btn primary onClick={saveCommAssign}>Save commission</Btn>
            </>}>
            <div style={{ background:"#EDE9FE", border:"1px solid #C4B5FD", borderRadius:9, padding:"9px 12px", marginBottom:12, fontSize:13 }}>
              <b>{extraTypeLabel(ex.extra_type)}</b> · <b style={{ color:"#6D28D9" }}>{money(ex.amount) || "$0"}</b>
              <span style={{ fontSize:10.5, fontWeight:700, color:"#6D28D9", background:"#fff", borderRadius:20, padding:"1px 8px", marginLeft:8 }}>Collected via payment</span>
              {g && <div style={{ fontSize:11, color:"#6D28D9", marginTop:3 }}>Job {g.job_number || "—"} · {g.customer || ""}</div>}
            </div>
            <Field label="Generated by">
              <select style={inp} value={ca.generated_by} disabled={locked} onChange={e => onGen(e.target.value)}>
                {GEN_BY.map(gb => <option key={gb.v} value={gb.v}>{gb.l}</option>)}
              </select>
            </Field>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
              <Field label="Driver">
                <select style={inp} value={ca.driver_id || ""} onChange={e => setCA({ driver_id: e.target.value })}>
                  <option value="">— Select —</option>
                  {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </Field>
              {ca.generated_by !== "driver_only" && <Field label="Rep">
                <select style={inp} value={ca.rep_id || ""} onChange={e => setCA({ rep_id: e.target.value })}>
                  <option value="">— Select —</option>
                  {employees.map(em => <option key={em.id} value={em.id}>{em.name}</option>)}
                </select>
              </Field>}
              <Field label="Driver %"><input style={inp} type="number" value={ca.driver_pct} onChange={e => setCA({ driver_pct: e.target.value })} /></Field>
              {ca.generated_by !== "driver_only" && <Field label="Rep %"><input style={inp} type="number" value={ca.rep_pct} onChange={e => setCA({ rep_pct: e.target.value })} /></Field>}
            </div>
            <div style={{ marginTop:12, background:"#fafafa", borderRadius:8, padding:"9px 12px", fontSize:12.5 }}>
              <div style={{ marginBottom:5, color:"#666" }}>Commission base: <b>{money(base) || "$0"}</b></div>
              <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                <span>Driver commission ({dPct}%): <b style={{ color:"#1A8A4E" }}>{money(dc) || "$0"}</b></span>
                <span>Rep commission ({rPct}%): <b style={{ color:"#185FA5" }}>{money(rc) || "$0"}</b></span>
                <span>Company: <b style={{ color:"#EF9F27" }}>{money(base - dc - rc) || "$0"}</b></span>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* ── Duplicates review ── */}
      {showDupModal && (() => {
        const R = duplicateReport;
        const card = { border:"1px solid #eee", borderRadius:9, padding:"10px 12px", background:"#fff", flex:"1 1 200px", minWidth:180 };
        const rowWrap = { display:"flex", gap:8, flexWrap:"wrap", alignItems:"stretch", marginBottom:8 };
        const groupBox = { border:"1px solid #F4DDB0", background:"#FFFCF5", borderRadius:11, padding:"12px 14px", marginBottom:12 };
        const miniBtn = { padding:"3px 9px", fontSize:11.5 };
        const sectionTitle = (icon, label, n) => <div style={{ fontSize:13, fontWeight:800, margin:"4px 0 8px", display:"flex", alignItems:"center", gap:7 }}>{icon} {label} <span style={{ fontSize:11, fontWeight:700, color:"#B45309", background:"#FFF1D6", borderRadius:20, padding:"1px 8px" }}>{n}</span></div>;
        return (
          <Modal title="Duplicate review" onClose={() => { setShowDupModal(false); setDupFocus(null); }}
            footer={<Btn onClick={() => { setShowDupModal(false); setDupFocus(null); }}>Close</Btn>}>
            <p style={{ fontSize:12.5, color:"#666", marginTop:-4, marginBottom:14 }}>Possible duplicates detected in the system. Review each one: <b>delete</b> the repeated record or <b>dismiss</b> if it is a false positive.</p>
            {(dupFocus ? R[dupFocus].length === 0 : R.total === 0) && <div style={{ background:"#EAF3DE", border:"1px solid #639922", borderRadius:10, padding:"16px", textAlign:"center", color:"#3B6D11", fontSize:13 }}>✅ No pending duplicates. All clean.</div>}

            {(!dupFocus || dupFocus === "jobs") && R.jobs.length > 0 && <div style={{ marginBottom:8 }}>
              {sectionTitle("💼", "Jobs with the same number", R.jobs.length)}
              {R.jobs.map(d => (
                <div key={d.key} style={groupBox}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                    <b style={{ fontFamily:"monospace", fontSize:13 }}>{d.number || "(no #)"}</b>
                    <span style={{ fontSize:11, color:"#999" }}>· {d.variants.length} distinct clients with this number</span>
                    <span style={{ marginLeft:"auto" }}><Btn onClick={() => dismissDup(d.key)} style={miniBtn}>Descartar</Btn></span>
                  </div>
                  <div style={rowWrap}>
                    {d.variants.map((v, i) => (
                      <div key={i} style={card}>
                        <div style={{ fontWeight:700, fontSize:12.5 }}>{v.customer}</div>
                        <div style={{ fontSize:11, color:"#777", margin:"3px 0 8px" }}><StatusBadge status={v.status} /> · {v.date || "—"} · {v.ids.length} fila(s)</div>
                        <div style={{ display:"flex", gap:6 }}>
                          <Btn onClick={() => { setShowDupModal(false); setJobDetailKey(v.key); }} style={miniBtn}>Ver</Btn>
                          <Btn danger onClick={() => deleteJobRows(v.ids, `${d.number} · ${v.customer}`)} style={miniBtn}>Delete this</Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>}

            {(!dupFocus || dupFocus === "payments") && R.payments.length > 0 && <div style={{ marginBottom:8 }}>
              {sectionTitle("💰", "Payments with the same serial", R.payments.length)}
              {R.payments.map(d => (
                <div key={d.key} style={groupBox}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                    <b style={{ fontFamily:"monospace", fontSize:13 }}>{d.kind} #{d.serial}</b>
                    <span style={{ fontSize:11, color:"#999" }}>· {d.rows.length} payments</span>
                    <span style={{ marginLeft:"auto" }}><Btn onClick={() => dismissDup(d.key)} style={miniBtn}>Descartar</Btn></span>
                  </div>
                  <div style={rowWrap}>
                    {d.rows.map(p => { const k = jobKeyByRowId[p.job_id]; return (
                      <div key={p.id} style={card}>
                        <div style={{ fontWeight:800, fontSize:13, color:"#1A8A4E" }}>${Math.round(numv(p.amount)).toLocaleString()}</div>
                        <div style={{ fontSize:11, color:"#777", margin:"3px 0 8px" }}><PaymentMethodBadge method={p.method} /> · {p.payment_date || "—"} · job {payJobNumber(p)}{p.split_group ? " · split" : ""}</div>
                        <div style={{ display:"flex", gap:6 }}>
                          {k && <Btn onClick={() => { setShowDupModal(false); setJobDetailKey(k); }} style={miniBtn}>Ver</Btn>}
                          <Btn danger onClick={() => deletePaymentRow(p)} style={miniBtn}>Delete this</Btn>
                        </div>
                      </div>
                    ); })}
                  </div>
                </div>
              ))}
            </div>}

            {(!dupFocus || dupFocus === "storages") && R.storages.length > 0 && <div style={{ marginBottom:8 }}>
              {sectionTitle("🏬", "Storages abiertos repetidos", R.storages.length)}
              {R.storages.map(d => (
                <div key={d.key} style={groupBox}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                    <b style={{ fontSize:13 }}>{d.rows[0].brand}  · Unit {d.rows[0].unit}{d.rows[0].state ? ` · ${d.rows[0].state}` : ""}</b>
                    <span style={{ fontSize:11, color:"#999" }}>· {d.rows.length} open</span>
                    <span style={{ marginLeft:"auto" }}><Btn onClick={() => dismissDup(d.key)} style={miniBtn}>Descartar</Btn></span>
                  </div>
                  <div style={rowWrap}>
                    {d.rows.map(r => (
                      <div key={r.id} style={card}>
                        <div style={{ fontWeight:700, fontSize:12.5 }}>{r.brand} {r.unit}</div>
                        <div style={{ fontSize:11, color:"#777", margin:"3px 0 8px" }}>{r.state || "—"}{r.account ? ` · ${r.account}` : ""}{r.date_opened ? ` · abierto ${r.date_opened}` : ""}</div>
                        <div style={{ display:"flex", gap:6 }}>
                          <Btn onClick={() => { setShowDupModal(false); setDetailId(r.id); }} style={miniBtn}>Ver</Btn>
                          <Btn danger onClick={() => deleteRecord(r.id)} style={miniBtn}>Delete this</Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>}
          </Modal>
        );
      })()}

      {/* ── Trip detail / live-load management (mobile-friendly) ── */}
      {tripDetailId && (() => {
        const t = trips.find(x => x.id === tripDetailId);
        if (!t) return null;
        const c = tripCalc(t);
        const truck = truckById[t.truck_id];
        const driverNm = driverById[t.driver_id]?.name || "";
        const inTransit = t.status === "in_transit";
        const canAddJobs = t.status === "in_transit" || t.status === "loading";
        const over = c.cap > 0 ? Math.max(0, Math.round(c.loadedCf - c.cap)) : 0;
        const pct = c.occPct || 0;
        const undelivered = c.jobsIn.filter(j => !(j.date_out || j.status === "delivered"));
        const events = tripEventsByTrip[t.id] || [];
        const dropTargets = [
          ...records.filter(r => r.space_type !== "warehouse").map(r => ({ kind:"unit", id:r.id, label:[r.brand, r.unit && "U"+r.unit, r.state].filter(Boolean).join(" ") || `Unit #${r.id}` })),
          ...WAREHOUSES.map(w => ({ kind:"warehouse", name:w, label:`🏭 ${w}` })),
        ];
        // Jobs that can be added (not on any trip, not delivered).
        const addableSeen = new Set(); const addable = [];
        for (const j of jobs) {
          if (j.trip_id || j.date_out || j.status === "delivered" || j.status === "cancelled") continue;
          const k = tripUnitKey(j); if (addableSeen.has(k)) continue; addableSeen.add(k);
          addable.push(j);
        }
        const q = tripAddJobSearch.trim().toLowerCase();
        const addableFiltered = (q ? addable.filter(j => [j.job_number, j.customer].join(" ").toLowerCase().includes(q)) : addable).slice(0, 40);
        const bigBtn = { flex:1, justifyContent:"center", padding:"11px 10px", fontSize:13 };
        const setU = (fields) => setUnplannedForm(f => ({ ...f, ...fields }));
        return (
          <Modal title={`Trip ${t.trip_number || "#"+t.id}`} onClose={() => { setTripDetailId(null); setTripAction(null); setStorageDropJob(null); setTripWaLink(null); }}
            footer={<>
              {t.status === "loading" && <Btn onClick={() => setTripStatus(t, "in_transit")}>Depart (in transit)</Btn>}
              {TRIP_ACTIVE(t.status) && <Btn primary onClick={() => { setCompleteDropTarget(""); setTripCompleteModal({ trip: t }); }}>Complete trip…</Btn>}
              {TRIP_ACTIVE(t.status) && <Btn danger onClick={() => setTripStatus(t, "cancelled")}>Cancel trip</Btn>}
              <Btn onClick={() => { setTripDetailId(null); setTripAction(null); }}>Close</Btn>
            </>}>
            <div style={{ fontSize:12.5, color:"#888", marginTop:-4, marginBottom:10 }}>
              <TripBadge status={t.status} /> &nbsp;🚛 {truck?.name || "no truck"}{driverNm ? ` · 🧑‍✈️ ${driverNm}` : ""}{t.departure_date ? ` · ${t.departure_date}` : ""}
            </div>

            {/* pending driver WhatsApp update */}
            {tripWaLink && (
              <div style={{ background:"#EAF3DE", border:"1px solid #639922", borderRadius:9, padding:"9px 12px", marginBottom:12, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <span style={{ fontSize:12.5, color:"#3B6D11", flex:1 }}>{tripWaLink.label} — notify the driver</span>
                <a href={tripWaLink.href} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn primary style={{ padding:"5px 11px", fontSize:12 }}>📲 Send update</Btn></a>
                <button onClick={() => setTripWaLink(null)} style={{ border:"none", background:"none", cursor:"pointer", color:"#3B6D11", fontSize:16 }}>×</button>
              </div>
            )}

            {/* live load bar */}
            {c.cap > 0 ? (
              <div style={{ marginBottom:6 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4 }}>
                  <b style={{ color: occColor(pct) }}>{pct}% occupied</b>
                  <span style={{ color:"#888" }}>{Math.round(c.loadedCf).toLocaleString()} / {c.cap.toLocaleString()} CF</span>
                </div>
                <div style={{ background:"#f0f0f0", borderRadius:6, height:14, overflow:"hidden" }}><div style={{ background: occColor(pct), height:14, width:`${Math.min(100, pct)}%`, transition:"width .4s" }} /></div>
              </div>
            ) : <div style={{ fontSize:12, color:"#999", marginBottom:6 }}>Truck with no capacity set · {Math.round(c.totalCf).toLocaleString()} CF on the trip</div>}
            {over > 0 && <div style={{ background:"#FCEBEB", border:"1px solid #E24B4A", borderRadius:8, padding:"8px 11px", fontSize:12.5, fontWeight:700, color:"#A32D2D", margin:"8px 0" }}>⚠️ Over capacity by {over.toLocaleString()} CF</div>}

            {/* Read-only delivery progress indicator (never changes trip status) */}
            {c.count > 0 && <div style={{ fontSize:12.5, color:"#666", margin:"6px 0" }}>
              {c.deliveryCount > 0 && <>📦 Delivered: <b style={{ color: c.delivered === c.deliveryCount ? "#3B6D11" : "#111" }}>{c.delivered}/{c.deliveryCount}</b></>}
              {c.relocCount > 0 && <>{c.deliveryCount > 0 ? " · " : ""}🔁 Relocated: <b style={{ color: c.relocDone === c.relocCount ? "#3B6D11" : "#111" }}>{c.relocDone}/{c.relocCount}</b></>}
              {!c.allDelivered ? ` · ${(c.deliveryCount - c.delivered) + (c.relocCount - c.relocDone)} pending` : ""}
            </div>}

            {/* Non-blocking suggestion — trip stays as-is until the dispatcher acts */}
            {c.allDelivered && TRIP_ACTIVE(t.status) && (
              <div style={{ background:"#EAF3DE", border:"1px solid #639922", borderRadius:9, padding:"10px 12px", margin:"8px 0", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                <span style={{ fontSize:12.5, color:"#3B6D11", flex:1 }}>✅ {c.relocCount > 0 ? "All stops done (deliveries + relocations)" : "All jobs delivered"} — mark trip as completed?</span>
                <Btn primary style={{ padding:"5px 12px", fontSize:12 }} onClick={() => { setCompleteDropTarget(""); setTripCompleteModal({ trip: t }); }}>Mark completed</Btn>
              </div>
            )}

            {/* loading / in-transit action buttons */}
            {canAddJobs && !tripAction && !storageDropJob && (
              <div style={{ display:"flex", gap:8, margin:"12px 0", flexWrap:"wrap" }}>
                <Btn primary onClick={() => { setTripAction("add"); setTripAddJobSearch(""); }} style={bigBtn}>➕ Add job</Btn>
                <Btn onClick={() => setTripAction("pickup")} style={bigBtn}>🔼 Load from storage</Btn>
                <Btn onClick={() => { setUnplannedForm(EMPTY_UNPLANNED); setTripAction("unplanned"); }} style={bigBtn}>🆕 Unplanned pickup</Btn>
                <Btn onClick={() => { setHandoffForm({ jobKey:"", to:"", reason:"better_fit", note:"" }); setTripAction("handoff"); }} style={bigBtn}>🔄 Handoff</Btn>
              </div>
            )}

            {/* action panel: driver handoff (whole trip or a single job) */}
            {tripAction === "handoff" && (() => {
              const hf = handoffForm;
              const setH = (fields) => setHandoffForm(f => ({ ...f, ...fields }));
              const jobSel = hf.jobKey ? c.jobsIn.find(j => jobKey(j) === hf.jobKey) : null;
              const fromNm = jobSel
                ? ((Array.isArray(jobSel.driver_ids) && jobSel.driver_ids.length ? driverById[jobSel.driver_ids[0]]?.name : "") || jobSel.driver || driverNm || "—")
                : (driverNm || "—");
              return (
                <div style={{ border:"1px solid #e5e5e5", borderRadius:10, padding:"12px", margin:"10px 0", background:"#fafafa" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}><b style={{ fontSize:13 }}>🔄 Handoff de driver</b><button onClick={() => setTripAction(null)} style={{ marginLeft:"auto", border:"none", background:"none", cursor:"pointer", color:"#888" }}>cancel</button></div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                    <Field label="Qué se traspasa">
                      <select style={inp} value={hf.jobKey} onChange={e => setH({ jobKey: e.target.value })}>
                        <option value="">Trip completo (cambio de camión)</option>
                        {c.jobsIn.filter(j => !(j.date_out || j.status === "delivered")).map(j => (
                          <option key={j.id} value={jobKey(j)}>Job {j.job_number || "(sin #)"} · {j.customer || "—"}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="De"><input style={{ ...inp, background:"#f1f1f1" }} value={fromNm} disabled /></Field>
                    <Field label="Pasar a *">
                      <select style={inp} value={hf.to} onChange={e => setH({ to: e.target.value })}>
                        <option value="">— Elegir driver —</option>
                        {driversList.filter(d => d.name !== fromNm).map(d => <option key={d.id} value={d.id}>{d.name}{d.truck_id ? ` · ${d.truck_id}` : ""}</option>)}
                      </select>
                    </Field>
                    <Field label="Motivo">
                      <select style={inp} value={hf.reason} onChange={e => setH({ reason: e.target.value })}>
                        {HANDOFF_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </Field>
                    <Field label="Nota (opcional)" full><input style={inp} value={hf.note} onChange={e => setH({ note: e.target.value })} placeholder="Detalle del traspaso" /></Field>
                  </div>
                  <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
                    <Btn primary disabled={tripBusy || !hf.to} onClick={async () => {
                      const toNm = driverById[Number(hf.to)]?.name || "";
                      if (!window.confirm(hf.jobKey ? `¿Pasar el job a ${toNm}? Desde ahora los extras y el efectivo de este job quedan a su nombre.` : `¿Pasar el trip completo a ${toNm}?`)) return;
                      if (hf.jobKey) await handoffJob(hf.jobKey, hf.to, hf.reason, hf.note);
                      else await handoffTrip(t, hf.to, hf.reason, hf.note);
                      setTripAction(null);
                    }}>{tripBusy ? "..." : "Confirmar handoff"}</Btn>
                  </div>
                </div>
              );
            })()}

            {/* action panel: add existing job */}
            {tripAction === "add" && (
              <div style={{ border:"1px solid #e5e5e5", borderRadius:10, padding:"12px", margin:"10px 0", background:"#fafafa" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}><b style={{ fontSize:13 }}>Add job to trip</b><button onClick={() => setTripAction(null)} style={{ marginLeft:"auto", border:"none", background:"none", cursor:"pointer", color:"#888" }}>cancel</button></div>
                <input style={inp} value={tripAddJobSearch} onChange={e => setTripAddJobSearch(e.target.value)} placeholder="Search by job # or client…" />
                <div style={{ border:"1px solid #f0f0f0", borderRadius:8, marginTop:8, maxHeight:230, overflowY:"auto", background:"#fff" }}>
                  {addableFiltered.length === 0 ? <div style={{ padding:"12px", fontSize:12, color:"#bbb" }}>No jobs available.</div>
                    : addableFiltered.map(j => (
                      <div key={j.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px", borderBottom:"1px solid #f6f6f6", fontSize:12 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div><b className="mono" style={{ fontFamily:"monospace" }}>{j.job_number || "(no #)"}</b> · {j.customer || "—"}</div>
                          <div style={{ color:"#888", marginTop:2, display:"flex", gap:8, flexWrap:"wrap" }}>
                            <span>{Math.round(effCf(j))} CF{hasRealCf(j) ? " ✓" : ""}</span><FaddBadge fadd={j.fadd} />
                            {j.sticker_color && <span style={{ width:9, height:9, borderRadius:"50%", background:colorHex(j.sticker_color)||"#ccc", border:"1px solid #ccc" }} />}
                            {(j.storage_id || j.warehouse) && <span>📦 {j.warehouse ? `Warehouse ${j.warehouse}` : (storageById[j.storage_id]?.brand || "unit")}</span>}
                          </div>
                        </div>
                        <Btn primary disabled={tripBusy} onClick={() => tripAddExistingJob(t, tripUnitKey(j))} style={{ padding:"4px 10px", fontSize:11 }}>Add</Btn>
                        {!tripPurposeColMissing && <Btn disabled={tripBusy} onClick={() => tripAddExistingJob(t, tripUnitKey(j), "relocation")} title={trAI("Add as internal relocation — no delivery, no collection", "Agregar como reubicación interna — sin delivery, sin cobro")} style={{ padding:"4px 10px", fontSize:11 }}>🔁 {trAI("Relocate", "Reubicar")}</Btn>}
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* action panel: pick up from storage */}
            {tripAction === "pickup" && (
              <div style={{ border:"1px solid #e5e5e5", borderRadius:10, padding:"12px", margin:"10px 0", background:"#fafafa" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}><b style={{ fontSize:13 }}>Load a job from storage</b><button onClick={() => setTripAction(null)} style={{ marginLeft:"auto", border:"none", background:"none", cursor:"pointer", color:"#888" }}>cancel</button></div>
                <div style={{ border:"1px solid #f0f0f0", borderRadius:8, maxHeight:230, overflowY:"auto", background:"#fff" }}>
                  {jobsInStorage.length === 0 ? <div style={{ padding:"12px", fontSize:12, color:"#bbb" }}>No hay jobs en storage para cargar.</div>
                    : jobsInStorage.map(j => (
                      <div key={j.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px", borderBottom:"1px solid #f6f6f6", fontSize:12 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div><b style={{ fontFamily:"monospace" }}>{j.job_number || "(no #)"}</b> · {j.customer || "—"}</div>
                          <div style={{ color:"#888", marginTop:2 }}>{Math.round(effCf(j))} CF · 📦 {j.warehouse ? `Warehouse ${j.warehouse}` : (storageById[j.storage_id]?.brand || "unit")}</div>
                        </div>
                        <Btn primary disabled={tripBusy} onClick={() => tripPickupFromStorage(t, tripUnitKey(j))} style={{ padding:"4px 10px", fontSize:11 }}>Load</Btn>
                        {!tripPurposeColMissing && <Btn disabled={tripBusy} onClick={() => tripPickupFromStorage(t, tripUnitKey(j), "relocation")} title={trAI("Load to relocate to another location — no delivery, no collection", "Cargar para reubicar en otra location — sin delivery, sin cobro")} style={{ padding:"4px 10px", fontSize:11 }}>🔁 {trAI("Relocate", "Reubicar")}</Btn>}
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* action panel: unplanned pickup quick form */}
            {tripAction === "unplanned" && (
              <div style={{ border:"1px solid #e5e5e5", borderRadius:10, padding:"12px", margin:"10px 0", background:"#fafafa" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}><b style={{ fontSize:13 }}>Pick up no previsto</b><button onClick={() => setTripAction(null)} style={{ marginLeft:"auto", border:"none", background:"none", cursor:"pointer", color:"#888" }}>cancel</button></div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  <Field label="Job #"><input style={inp} value={unplannedForm.job_number} onChange={e => setU({ job_number:e.target.value })} placeholder="Job #" /></Field>
                  <Field label="Client"><input style={inp} value={unplannedForm.customer} onChange={e => setU({ customer:e.target.value })} placeholder="Client" /></Field>
                  <Field label="CF"><input style={inp} value={unplannedForm.volume} onChange={e => setU({ volume:e.target.value })} placeholder="ej: 600" /></Field>
                  <Field label="FADD"><input style={inp} type="date" value={unplannedForm.fadd} onChange={e => setU({ fadd:e.target.value })} /></Field>
                  <Field label="Pickup"><input style={inp} value={unplannedForm.pickup_address} onChange={e => setU({ pickup_address:e.target.value })} placeholder="Pickup address" /></Field>
                  <Field label="Delivery"><input style={inp} value={unplannedForm.delivery_address} onChange={e => setU({ delivery_address:e.target.value })} placeholder="Delivery address" /></Field>
                  <Field label="Broker"><select style={inp} value={unplannedForm.broker_id} onChange={e => setU({ broker_id:e.target.value })}><option value="">— Broker —</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
                  <Field label="Sticker"><input style={inp} list="sticker-colors-list" value={unplannedForm.sticker_color} onChange={e => setU({ sticker_color:e.target.value })} placeholder="Color" /></Field>
                  <Field label="Lot #"><input style={inp} value={unplannedForm.lot_number} onChange={e => setU({ lot_number:e.target.value })} placeholder="Lot" /></Field>
                </div>
                <div style={{ marginTop:10, textAlign:"right" }}><Btn primary disabled={tripBusy || (!unplannedForm.job_number && !unplannedForm.customer)} onClick={() => saveUnplannedPickup(t)}>Add to trip</Btn></div>
              </div>
            )}

            {/* per-job storage drop panel */}
            {storageDropJob && storageDropJob.tripId === t.id && (
              <div style={{ border:"1px solid #EF9F27", borderRadius:10, padding:"12px", margin:"10px 0", background:"#FFF8F0" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}><b style={{ fontSize:13 }}>Drop at storage: {storageDropJob.label}</b><button onClick={() => setStorageDropJob(null)} style={{ marginLeft:"auto", border:"none", background:"none", cursor:"pointer", color:"#888" }}>cancel</button></div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <select id="drop-target-sel" style={{ ...inp, flex:1, minWidth:180 }} defaultValue="">
                    <option value="">— Choose storage / warehouse —</option>
                    {dropTargets.map((d, i) => <option key={i} value={i}>{d.label}</option>)}
                  </select>
                  <Btn primary disabled={tripBusy} onClick={() => { const sel = document.getElementById("drop-target-sel"); const idx = sel?.value; if (idx === "" || idx == null) { window.alert("Choose a destination."); return; } tripDropAtStorage(t, storageDropJob.jobKey, dropTargets[Number(idx)]); }}>Confirmar drop</Btn>
                </div>
              </div>
            )}

            {/* stops — jobs + custom stops in one drag-reorderable sequence */}
            {(() => {
              const seq = tripSequenceByTrip[t.id] || [];
              const onRowDrop = (idx) => (e) => {
                e.preventDefault();
                const from = parseInt(e.dataTransfer.getData("text/plain"));
                if (isNaN(from) || from === idx) return;
                const arr = [...seq]; const [mv] = arr.splice(from, 1); arr.splice(idx, 0, mv);
                persistUnifiedOrder(t, arr);
              };
              const rowDrag = (idx) => ({ draggable:true, onDragStart:e => e.dataTransfer.setData("text/plain", String(idx)), onDragOver:e => e.preventDefault(), onDrop:onRowDrop(idx) });
              // Drop target only — drag is initiated by the handle, so row-body clicks work.
              const dropOnly = (idx) => ({ onDragOver:e => e.preventDefault(), onDrop:onRowDrop(idx) });
              const numBadge = (bg, n) => <span style={{ width:22, height:22, borderRadius:"50%", background:bg, color:"#fff", fontSize:11, fontWeight:700, display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{n}</span>;
              const handle = <span title={trAI("Drag to reorder", "Arrastrá para reordenar")} style={{ color:"#ccc", cursor:"grab", flexShrink:0 }}>⠿</span>;
              const dragHandleAt = (idx) => <span draggable onDragStart={e => e.dataTransfer.setData("text/plain", String(idx))} title={trAI("Drag to reorder", "Arrastrá para reordenar")} style={{ color:"#ccc", cursor:"grab", flexShrink:0 }}>⠿</span>;
              return (<>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", margin:"6px 0 6px" }}>
                  <span style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>Stops ({seq.length})</span>
                  <Btn disabled={tripStopsMissing} onClick={() => openAddStop(t)} style={{ padding:"4px 10px", fontSize:11.5 }}>➕ {trAI("Add stop", "Agregar parada")}</Btn>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {seq.length === 0 ? <div style={{ fontSize:12, color:"#bbb", padding:"8px" }}>{trAI("No stops on this trip.", "Sin paradas en este trip.")}</div>
                    : seq.map((item, i) => {
                      if (item.kind === "custom") {
                        const s = item.s, cat = tripStopCat(s.category);
                        return (
                          <div key={item.key} {...dropOnly(i)} style={{ display:"flex", alignItems:"flex-start", gap:8, border:"1px solid #f0f0f0", borderRadius:10, padding:"9px 11px", background: s.done ? "#fafafa" : "#fbfbfd", opacity: s.done ? 0.7 : 1 }}>
                            {dragHandleAt(i)}
                            {numBadge(cat.color, i + 1)}
                            <div onClick={() => openEditStop(t, s)} title={trAI("Edit address / note", "Editar dirección / nota")} style={{ flex:1, minWidth:0, cursor:"pointer" }}>
                              <span style={{ fontSize:11, fontWeight:700, color:cat.color, background:cat.color+"18", borderRadius:20, padding:"2px 9px", whiteSpace:"nowrap" }}>{cat.icon} {catLabel(s.category)}</span>
                              {s.done && <span style={{ fontSize:10, fontWeight:600, color:"#3B6D11", marginLeft:6 }}>{trAI("Done", "Hecho")}</span>}
                              {s.address
                                ? <div style={{ fontSize:12, color:"#555", marginTop:4 }}>📍 {s.address}</div>
                                : <div style={{ fontSize:12, color:"#bbb", marginTop:4, fontStyle:"italic" }}>{trAI("Add address / note…", "Agregar dirección / nota…")}</div>}
                              {s.note && <div style={{ fontSize:12, color:"#888", marginTop:2, whiteSpace:"pre-wrap" }}>{s.note}</div>}
                            </div>
                            <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                              <button title={trAI("Edit address / note", "Editar dirección / nota")} onClick={() => openEditStop(t, s)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, lineHeight:1 }}>✏️</button>
                              <span title={trAI("Mark done", "Marcar hecho")} onClick={() => toggleCustomStop(s)} style={{ cursor:"pointer", fontSize:15 }}>{s.done ? "✅" : "⬜"}</span>
                              <button title={trAI("Delete stop", "Eliminar parada")} onClick={() => deleteCustomStop(s)} style={{ background:"none", border:"none", color:"#c0392b", cursor:"pointer", fontSize:15, lineHeight:1 }}>✕</button>
                            </div>
                          </div>
                        );
                      }
                      const j = item.j;
                      const reloc = isRelocation(j);
                      const delivered = !!j.date_out || j.status === "delivered";
                      // A relocation stop is only "done" once it was actually dropped at the
                      // destination (storage_drop event); in_storage without that event means
                      // it's still waiting at its origin location.
                      const relocDropped = reloc && events.some(e => e.event_type === "storage_drop" && e.job_id && jobRowIdsForUnit(tripUnitKey(j)).includes(e.job_id));
                      const dropped = !delivered && j.status === "in_storage" && (!reloc || relocDropped);
                      const relocAtOrigin = reloc && !delivered && j.status === "in_storage" && !relocDropped;
                      const dropLoc = j.warehouse ? `Warehouse ${j.warehouse}` : (storageById[j.storage_id]?.brand || "storage");
                      const fromTo = [j.pickup_state, j.delivery_state].filter(Boolean).join(" → ");
                      return (
                        <div key={item.key} {...rowDrag(i)} style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", background: (delivered || dropped) ? "#fafafa" : "#fff", cursor:"grab", opacity: (delivered || dropped) ? 0.75 : 1 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                            {handle}
                            {numBadge("#111", i + 1)}
                            <button onClick={() => setJobDetailKey(jobKey(j))} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                            {j.split_group && <span style={{ fontSize:10, color:"#7C3AED", fontWeight:700 }} title="Split load — one portion of this job">✂️ {splitLabel(j)}</span>}
                            {reloc && <span title={trAI("Internal move between locations — no delivery, no collection", "Movimiento interno entre locations — sin delivery, sin cobro")} style={{ fontSize:10.5, fontWeight:700, color:"#185FA5", background:"#E6F1FB", borderRadius:20, padding:"2px 9px", whiteSpace:"nowrap" }}>🔁 Relocation</span>}
                            <span style={{ fontSize:13 }}>{j.customer || "—"}</span>
                            {fromTo && <span style={{ fontSize:11, color:"#888" }}>· {fromTo}</span>}
                            {delivered && <span style={{ marginLeft:"auto", fontSize:10.5, fontWeight:700, color:"#3B6D11", background:"#EAF3DE", borderRadius:20, padding:"2px 9px" }}>Delivered</span>}
                            {dropped && <span title={dropLoc} style={{ marginLeft:"auto", fontSize:10.5, fontWeight:700, color: reloc ? "#3B6D11" : "#185FA5", background: reloc ? "#EAF3DE" : "#E7EFF8", borderRadius:20, padding:"2px 9px", whiteSpace:"nowrap" }}>{reloc ? `✅ Relocated · ${dropLoc}` : "📦 Dropped in storage"}</span>}
                            {relocAtOrigin && <span title={dropLoc} style={{ marginLeft:"auto", fontSize:10.5, fontWeight:700, color:"#854F0B", background:"#FEF3C7", borderRadius:20, padding:"2px 9px", whiteSpace:"nowrap" }}>📦 At origin · {dropLoc}</span>}
                          </div>
                          <div style={{ display:"flex", alignItems:"center", gap:10, margin:"6px 0", flexWrap:"wrap", fontSize:12, color:"#666" }}>
                            <span title={hasRealCf(j) ? `Real (est. ${Math.round(parseCf(j.volume))} CF)` : "Estimado del broker"}>
                              {Math.round(effCf(j))} CF{hasRealCf(j) ? <b style={{ color:"#3B6D11" }}> ✓real</b> : <span style={{ color:"#aaa" }}> est.</span>}
                            </span>
                            {!realCfMissing && <button onClick={() => quickSetRealCf(j)} title="Cargar el CF real medido" style={{ border:"1px solid #e5e5e5", background:"#fff", borderRadius:6, cursor:"pointer", fontSize:10.5, padding:"1px 7px", color:"#185FA5" }}>✏️ CF real</button>}
                            {j.sticker_color && <span style={{ width:10, height:10, borderRadius:"50%", background:colorHex(j.sticker_color)||"#ccc", border:"1px solid #ccc" }} title={j.sticker_color} />}
                            {j.lot_number && <span style={{ fontFamily:"monospace" }}>{j.lot_number}</span>}
                            <FaddBadge fadd={j.fadd} />
                            {!reloc && jobToCollect(j) > 0 && <span style={{ color:"#1A8A4E", fontWeight:600 }}>${Math.round(jobToCollect(j)).toLocaleString()}</span>}
                            {reloc && jobToCollect(j) > 0 && <span title={trAI("Outstanding balance — NOT collected on this trip (relocation)", "Balance pendiente — NO se cobra en este trip (reubicación)")} style={{ color:"#999", textDecoration:"line-through" }}>${Math.round(jobToCollect(j)).toLocaleString()}</span>}
                            {(() => {
                              // A stop owned by a different driver than the trip's → show who.
                              const jd = (Array.isArray(j.driver_ids) && j.driver_ids.length ? driverById[j.driver_ids[0]]?.name : "") || "";
                              return jd && jd !== driverNm
                                ? <span title="Este job está a cargo de otro driver (handoff)" style={{ fontSize:10.5, fontWeight:700, color:"#92760B", background:"#FEF3C7", borderRadius:20, padding:"1px 8px" }}>🧑‍✈️ {jd}</span>
                                : null;
                            })()}
                          </div>
                          {!delivered && !dropped && (
                            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                              {!reloc && <Btn primary disabled={tripBusy} onClick={() => tripMarkDelivered(j, t)} style={{ flex:1, justifyContent:"center", padding:"9px", fontSize:12.5 }}>✅ Mark delivered</Btn>}
                              {relocAtOrigin && <Btn primary disabled={tripBusy} onClick={() => tripRelocLoad(t, j)} style={{ flex:1, justifyContent:"center", padding:"9px", fontSize:12.5 }}>🔼 {trAI("Load onto truck", "Cargar al camión")}</Btn>}
                              {inTransit && !relocAtOrigin && <Btn primary={reloc} disabled={tripBusy} onClick={() => setStorageDropJob({ tripId: t.id, jobKey: tripUnitKey(j), label: `${j.job_number || ""} ${j.customer || ""}`.trim() })} style={{ flex:1, justifyContent:"center", padding:"9px", fontSize:12.5 }}>📦 {reloc ? trAI("Drop at destination", "Dejar en destino") : "Drop at storage"}</Btn>}
                              <Btn disabled={tripBusy} onClick={() => { setHandoffForm({ jobKey: tripUnitKey(j), to:"", reason:"better_fit", note:"" }); setTripAction("handoff"); }} title="Pasar este job a otro driver" style={{ justifyContent:"center", padding:"9px 12px", fontSize:12.5 }}>🔄</Btn>
                              {!jobSplitColMissing && !reloc && <Btn disabled={tripBusy} onClick={() => { setSplitJobRow(j); setSplitCf(String(Math.round(effCf(j) / 2))); setSplitDest(""); }} title="Dividir este job en dos camiones" style={{ justifyContent:"center", padding:"9px 12px", fontSize:12.5 }}>✂️</Btn>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </>);
            })()}

            {/* internal equipment / materials riding this trip */}
            {!equipmentMissing && (() => {
              const cargo = equipmentItems.filter(i => i.trip_id === t.id);
              if (!cargo.length) return null;
              return (
                <div style={{ marginTop:12 }}>
                  <span style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>{trAI("Cargo / Equipment", "Carga / Equipo")} ({cargo.length})</span>
                  <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:6 }}>
                    {cargo.map(item => {
                      const cat = equipmentCat(item.category);
                      return (
                        <div key={item.id} style={{ display:"flex", alignItems:"center", gap:8, border:"1px solid #f0f0f0", borderRadius:10, padding:"8px 11px", fontSize:12.5 }}>
                          <span style={{ fontSize:11, fontWeight:700, color:cat.color, background:cat.color+"18", borderRadius:20, padding:"2px 8px", whiteSpace:"nowrap" }}>{cat.icon} {trAI(cat.label, cat.es)}</span>
                          <span style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}><b>{item.name || "—"}</b>{numv(item.quantity) > 1 ? ` ×${numv(item.quantity)}` : ""}</span>
                          <Btn disabled={tripBusy} onClick={() => setEquipUnloadItem(item)} style={{ padding:"3px 9px", fontSize:11 }}>📤 {trAI("Unload", "Descargar")}</Btn>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginTop:12 }}>
              <span style={{ color:"#666" }}>Total: <b>{Math.round(c.totalCf).toLocaleString()} CF</b></span>
              <span style={{ color:"#666" }}>To collect: <b style={{ color:"#1A8A4E" }}>${Math.round(c.totalCollect).toLocaleString()}</b></span>
            </div>
            <a href={tripManifestLink(t, truck?.name, driverNm, c.jobsIn, c.loadedCf, c.occPct, c.totalCollect)} target="_blank" rel="noreferrer" style={{ textDecoration:"none", display:"block", marginTop:10 }}><Btn style={{ width:"100%", justifyContent:"center" }}>💬 Send manifest to driver</Btn></a>

            {/* event log */}
            <button onClick={() => setTripLogOpen(o => !o)} style={{ width:"100%", display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", padding:"12px 0 6px", textAlign:"left", marginTop:8, borderTop:"1px solid #f0f0f0" }}>
              <span style={{ fontSize:11.5, fontWeight:700, color:"#666", textTransform:"uppercase", letterSpacing:"0.06em" }}>Trip log ({events.length})</span>
              <span style={{ marginLeft:"auto", color:"#bbb", fontSize:11, transform: tripLogOpen ? "rotate(90deg)" : "none", transition:"transform .15s" }}>▸</span>
            </button>
            {tripLogOpen && (
              tripEventsMissing ? <div style={{ fontSize:12, color:"#999", padding:"4px 0" }}>Run the updated SQL to enable the event log.</div>
              : events.length === 0 ? <div style={{ fontSize:12, color:"#bbb", padding:"4px 0" }}>No events recorded yet.</div>
              : <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {events.map(e => {
                    const j = e.job_id ? jobs.find(x => x.id === e.job_id) : null;
                    return (
                      <div key={e.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, padding:"6px 0", borderBottom:"1px solid #f6f6f6", flexWrap:"wrap" }}>
                        <span>{TRIP_EVENT_META[e.event_type]?.icon || "•"}</span>
                        <b>{tripEventLabel(e.event_type)}</b>
                        {(j?.job_number || e.notes) && <span style={{ fontFamily:"monospace", color:"#185FA5" }}>{e.event_type === "driver_handoff" ? e.notes : (j?.job_number || e.notes)}</span>}
                        <span style={{ fontSize:10.5, color:"#999", background:"#f1f1f1", borderRadius:20, padding:"1px 7px" }}>{e.created_by || "dispatcher"}</span>
                        <span style={{ marginLeft:"auto", color:"#aaa", fontSize:11 }}>{(e.created_at || "").replace("T", " ").slice(0, 16)}</span>
                      </div>
                    );
                  })}
                </div>
            )}
          </Modal>
        );
      })()}

      {tripCompleteModal && (() => {
        const t = tripCompleteModal.trip;
        const c = tripCalc(t);
        const undelivered = c.jobsIn.filter(j => !(j.date_out || j.status === "delivered"));
        // Jobs still physically on the truck need a drop target; jobs already sitting
        // in storage (dropped mid-trip, or relocations at destination) keep their
        // location and are only released from the trip.
        const onTruck = undelivered.filter(j => j.status !== "in_storage");
        const droppedMidTrip = undelivered.filter(j => j.status === "in_storage");
        const deliveredJobs = c.jobsIn.filter(j => j.date_out || j.status === "delivered");
        const cfDelivered = deliveredJobs.reduce((s, j) => s + effCf(j), 0);
        const bolCollected = deliveredJobs.reduce((s, j) => s + numv(j.bol_collected), 0);
        const bolPending = c.jobsIn.filter(j => !isRelocation(j)).reduce((s, j) => s + Math.max(0, numv(j.bol_balance) - numv(j.bol_collected)), 0);
        const dropTargets = [
          ...records.filter(r => r.space_type !== "warehouse").map(r => ({ kind:"unit", id:r.id, label:[r.brand, r.unit && "U"+r.unit, r.state].filter(Boolean).join(" ") || `Unit #${r.id}` })),
          ...WAREHOUSES.map(w => ({ kind:"warehouse", name:w, label:`🏭 ${w}` })),
        ];
        const dur = t.departure_date ? Math.max(0, Math.round((new Date(today() + "T00:00:00") - new Date(t.departure_date + "T00:00:00")) / 86400000)) : null;
        return (
          <Modal title={`Complete trip ${t.trip_number || "#"+t.id}`} onClose={() => setTripCompleteModal(null)}
            footer={<>
              <Btn onClick={() => setTripCompleteModal(null)}>Cancel</Btn>
              <Btn primary disabled={tripBusy || (onTruck.length > 0 && completeDropTarget === "")} onClick={() => completeTrip(t, onTruck.map(tripUnitKey), droppedMidTrip.map(tripUnitKey), completeDropTarget !== "" ? dropTargets[Number(completeDropTarget)] : null)}>{tripBusy ? "Saving..." : "Mark completed"}</Btn>
            </>}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
              {[
                { l:"Delivered jobs", v:`${deliveredJobs.length} / ${c.deliveryCount}` },
                ...(c.relocCount > 0 ? [{ l:"Relocations", v:`${c.relocDone} / ${c.relocCount}` }] : []),
                { l:"CF delivered", v:`${Math.round(cfDelivered).toLocaleString()} CF` },
                { l:"BOL collected", v:`$${Math.round(bolCollected).toLocaleString()}` },
                { l:"Outstanding balance", v:`$${Math.round(bolPending).toLocaleString()}` },
                { l:"Duration", v: dur != null ? `${dur} day(s)` : "—" },
              ].map(x => (
                <div key={x.l} style={{ border:"1px solid #efefef", borderRadius:9, padding:"10px 12px" }}>
                  <div style={{ fontSize:10.5, color:"#aaa", fontWeight:600 }}>{x.l}</div>
                  <div style={{ fontSize:16, fontWeight:800, marginTop:2 }}>{x.v}</div>
                </div>
              ))}
            </div>
            {onTruck.length > 0 && (
              <div style={{ background:"#FFF8F0", border:"1px solid #EF9F27", borderRadius:9, padding:"11px 13px" }}>
                <div style={{ fontSize:12.5, color:"#854F0B", fontWeight:600, marginBottom:6 }}>⚠️ {onTruck.length} job(s) still on the truck. Send to storage?</div>
                <div style={{ fontSize:11.5, color:"#888", marginBottom:8 }}>{onTruck.map(j => j.job_number || j.customer).filter(Boolean).join(", ")}</div>
                <select style={inp} value={completeDropTarget} onChange={e => setCompleteDropTarget(e.target.value)}>
                  <option value="">— Choose storage / warehouse for the undelivered —</option>
                  {dropTargets.map((d, i) => <option key={i} value={i}>{d.label}</option>)}
                </select>
              </div>
            )}
            {droppedMidTrip.length > 0 && (
              <div style={{ background:"#F4F8FD", border:"1px solid #B9D7F2", borderRadius:9, padding:"11px 13px", marginTop:8 }}>
                <div style={{ fontSize:12.5, color:"#185FA5", fontWeight:600 }}>📦 {droppedMidTrip.length} job(s) already dropped at a storage/warehouse — they keep their location and are released from the trip.</div>
                <div style={{ fontSize:11.5, color:"#888", marginTop:4 }}>{droppedMidTrip.map(j => `${j.job_number || j.customer || ""}${isRelocation(j) ? " (relocation)" : ""}`).filter(Boolean).join(", ")}</div>
              </div>
            )}
          </Modal>
        );
      })()}

      {/* Equipment: create / edit item */}
      {showEquipmentModal && (
        <Modal title={editingEquipmentId ? trAI("Edit item", "Editar item") : trAI("New equipment item", "Nuevo item de equipo")} onClose={() => setShowEquipmentModal(false)}
          footer={<>
            <Btn onClick={() => setShowEquipmentModal(false)}>{trAI("Cancel", "Cancelar")}</Btn>
            <Btn primary disabled={equipmentSaving || !equipmentForm.name.trim()} onClick={saveEquipmentItem}>{equipmentSaving ? trAI("Saving…", "Guardando…") : trAI("Save", "Guardar")}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label={trAI("Name", "Nombre")} full><input style={inp} value={equipmentForm.name} onChange={e => setEquipmentForm(f => ({ ...f, name: e.target.value }))} placeholder={trAI("e.g. Moving pads", "ej: Pads de mudanza")} /></Field>
            <Field label={trAI("Category", "Categoría")}>
              <select style={inp} value={equipmentForm.category} onChange={e => setEquipmentForm(f => ({ ...f, category: e.target.value }))}>
                {EQUIPMENT_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.icon} {trAI(c.label, c.es)}</option>)}
              </select>
            </Field>
            <Field label={trAI("Quantity", "Cantidad")}><input style={inp} type="number" min="1" value={equipmentForm.quantity} onChange={e => setEquipmentForm(f => ({ ...f, quantity: e.target.value }))} /></Field>
            <Field label="Location" full>
              <select style={inp} value={equipmentForm.location} onChange={e => setEquipmentForm(f => ({ ...f, location: e.target.value }))}>
                <option value="">{trAI("— Choose storage / warehouse —", "— Elegí storage / warehouse —")}</option>
                {WAREHOUSES.map(w => <option key={"w:"+w} value={"w:"+w}>🏭 {w}</option>)}
                {records.filter(r => r.space_type !== "warehouse").map(r => <option key={"u:"+r.id} value={"u:"+r.id}>{[r.brand, r.unit && "U"+r.unit, r.state].filter(Boolean).join(" ") || `Unit #${r.id}`}</option>)}
              </select>
            </Field>
            <Field label={trAI("Notes", "Notas")} full><input style={inp} value={equipmentForm.notes} onChange={e => setEquipmentForm(f => ({ ...f, notes: e.target.value }))} placeholder={trAI("Optional notes", "Notas opcionales")} /></Field>
          </div>
        </Modal>
      )}

      {/* Equipment: pick an active trip to load the item onto */}
      {equipLoadItem && (
        <Modal title={`🚚 ${trAI("Load on trip", "Cargar a trip")} · ${equipLoadItem.name || ""}`} onClose={() => setEquipLoadItem(null)}
          footer={<Btn onClick={() => setEquipLoadItem(null)}>{trAI("Cancel", "Cancelar")}</Btn>}>
          <div style={{ fontSize:13, color:"#555", marginBottom:10 }}>{trAI("Choose an active trip — the item rides as internal cargo (no money, no delivery).", "Elegí un trip activo — el item viaja como carga interna (sin plata, sin delivery).")}</div>
          <div style={{ border:"1px solid #f0f0f0", borderRadius:8, maxHeight:280, overflowY:"auto" }}>
            {trips.filter(t => TRIP_ACTIVE(t.status)).map(t => (
              <div key={t.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 12px", borderBottom:"1px solid #f6f6f6", fontSize:13 }}>
                <TripBadge status={t.status} />
                <b style={{ fontFamily:"monospace" }}>{t.trip_number || "#"+t.id}</b>
                <span style={{ flex:1, color:"#666", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{[truckById[t.truck_id]?.name, driverById[t.driver_id]?.name].filter(Boolean).join(" · ")}</span>
                <Btn primary onClick={() => equipmentLoadOnTrip(equipLoadItem, t.id)} style={{ padding:"4px 12px", fontSize:12 }}>{trAI("Load", "Cargar")}</Btn>
              </div>
            ))}
            {!trips.some(t => TRIP_ACTIVE(t.status)) && <div style={{ padding:"14px", fontSize:12, color:"#bbb" }}>{trAI("No active trips.", "No hay trips activos.")}</div>}
          </div>
        </Modal>
      )}

      {/* Equipment: choose destination to unload the item */}
      {equipUnloadItem && (() => {
        const targets = [
          ...records.filter(r => r.space_type !== "warehouse").map(r => ({ kind:"unit", id:r.id, label:[r.brand, r.unit && "U"+r.unit, r.state].filter(Boolean).join(" ") || `Unit #${r.id}` })),
          ...WAREHOUSES.map(w => ({ kind:"warehouse", name:w, label:`🏭 ${w}` })),
        ];
        return (
          <Modal title={`📤 ${trAI("Unload", "Descargar")} · ${equipUnloadItem.name || ""}`} onClose={() => setEquipUnloadItem(null)}
            footer={<Btn onClick={() => setEquipUnloadItem(null)}>{trAI("Cancel", "Cancelar")}</Btn>}>
            <div style={{ fontSize:13, color:"#555", marginBottom:10 }}>{trAI("Choose where the item was unloaded — it becomes available at that location.", "Elegí dónde se descargó el item — queda disponible en esa location.")}</div>
            <select id="equip-unload-sel" style={inp} defaultValue="">
              <option value="">{trAI("— Choose storage / warehouse —", "— Elegí storage / warehouse —")}</option>
              {targets.map((d, i) => <option key={i} value={i}>{d.label}</option>)}
            </select>
            <div style={{ marginTop:12, textAlign:"right" }}>
              <Btn primary onClick={() => { const sel = document.getElementById("equip-unload-sel"); const idx = sel?.value; if (idx === "" || idx == null) { window.alert(trAI("Choose a destination.", "Elegí un destino.")); return; } equipmentUnload(equipUnloadItem, targets[Number(idx)]); }}>{trAI("Confirm unload", "Confirmar descarga")}</Btn>
            </div>
          </Modal>
        );
      })()}

      {tripRouteModal && (
        <TripRouteModal title={tripRouteModal.title} waypoints={tripRouteModal.waypoints} googleLink={tripRouteModal.googleLink} onClose={() => setTripRouteModal(null)} />
      )}

      {addStopModal && (() => {
        const tr = addStopModal.trip;
        const editing = !!addStopModal.editId;
        return (
          <Modal title={`${editing ? trAI("Edit stop", "Editar parada") : trAI("Add stop", "Agregar parada")} · ${tr.trip_number || "#"+tr.id}`} onClose={() => setAddStopModal(null)}
            footer={<>
              <Btn onClick={() => setAddStopModal(null)}>{trAI("Cancel", "Cancelar")}</Btn>
              <Btn primary disabled={stopSaving} onClick={saveCustomStop}>{stopSaving ? trAI("Saving…", "Guardando…") : (editing ? trAI("Save changes", "Guardar cambios") : trAI("Add stop", "Agregar parada"))}</Btn>
            </>}>
            {!editing && <div style={{ fontSize:13, color:"#555", marginBottom:12 }}>{trAI("A non-job stop — maintenance, inspection, fuel, weigh station, rest, etc. It's added at the end of the trip's list.", "Una parada que no es un job — mantenimiento, inspección, combustible, báscula, descanso, etc. Se agrega al final de la lista del trip.")}</div>}
            <Field label={trAI("Category", "Categoría")} full>
              <select style={inp} value={stopForm.category} onChange={e => setStopForm(f => ({ ...f, category: e.target.value }))}>
                {TRIP_STOP_CATEGORIES.map(cat => (
                  <option key={cat.key} value={cat.key}>{cat.icon} {trAI(cat.label, cat.es)}</option>
                ))}
              </select>
            </Field>
            <Field label={trAI("Address (optional)", "Dirección (opcional)")} full>
              <input style={inp} value={stopForm.address} placeholder={trAI("Shop, station, terminal…", "Taller, estación, terminal…")} onChange={e => setStopForm(f => ({ ...f, address: e.target.value }))} />
            </Field>
            <Field label={trAI("Note (optional)", "Nota (opcional)")} full>
              <textarea style={{ ...inp, minHeight:70, resize:"vertical" }} value={stopForm.note} placeholder={trAI("Detail: oil change, DOT inspection, etc.", "Detalle: cambio de aceite, DOT inspection, etc.")} onChange={e => setStopForm(f => ({ ...f, note: e.target.value }))} />
            </Field>
          </Modal>
        );
      })()}

      {dropModal && (() => {
        const dropTargets = [
          ...records.filter(r => r.space_type !== "warehouse").map(r => ({ value:`u:${r.id}`, kind:"unit", id:r.id, label:[r.brand, r.unit && "U"+r.unit, r.state].filter(Boolean).join(" ") || `Unit #${r.id}` })),
          ...WAREHOUSES.map(w => ({ value:`w:${w}`, kind:"warehouse", name:w, label:`🏭 ${w}` })),
        ];
        const resetDrop = () => { setDropModal(null); setDropSel(""); setDropCreating(false); setDropNewUnit({ brand:"", unit:"", state:"", size:"" }); };
        // Quick-create a storage unit that isn't in the picklist yet, then auto-select it as the destination.
        const createDropUnit = async () => {
          const brand = dropNewUnit.brand.trim(), unit = dropNewUnit.unit.trim();
          if (!brand || !unit) { showToast("Enter company and unit #"); return; }
          const dup = findStorageDup(brand, unit, dropNewUnit.state);
          if (dup) {
            if (!window.confirm(`${dup.brand} Unit ${dup.unit}${dup.state ? ` in ${dup.state}` : ""} is already open in the system.\n\nUse the existing unit instead?`)) return;
            setDropSel(`u:${dup.id}`); setDropCreating(false); setDropNewUnit({ brand:"", unit:"", state:"", size:"" });
            return;
          }
          setDropCreatingBusy(true);
          const payload = { brand, unit, state: dropNewUnit.state || null, size: dropNewUnit.size || null, situation: "Open", created_by: userEmail };
          const { data, error } = await supabase.from("storages").insert([payload]).select().single();
          setDropCreatingBusy(false);
          if (error) { showToast(error.message); return; }
          setRecords(r => r.some(x => x.id === data.id) ? r : [data, ...r]); // realtime may also add it
          setDropSel(`u:${data.id}`); setDropCreating(false); setDropNewUnit({ brand:"", unit:"", state:"", size:"" });
          showToast("Unit created");
        };
        return (
          <Modal title={`Dropped at storage · ${dropModal.label}`} onClose={resetDrop}
            footer={<>
              <Btn onClick={resetDrop}>Cancel</Btn>
              <Btn primary disabled={tripBusy || dropSel === ""} onClick={async () => {
                const dm = dropModal, tgt = dropTargets.find(d => d.value === dropSel);
                if (!tgt) return;
                await tripDropAtStorage(dm.trip, dm.jobKey, tgt);
                resetDrop();
              }}>{tripBusy ? "Saving…" : "Confirm drop"}</Btn>
            </>}>
            <div style={{ fontSize:13, color:"#555", marginBottom:10 }}>The job wasn't delivered to the final customer — choose the storage unit or warehouse where it was left. It'll leave the trip and go back to storage.</div>
            <select style={inp} value={dropSel} onChange={e => setDropSel(e.target.value)}>
              <option value="">— Choose destination —</option>
              {dropTargets.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            {!dropCreating ? (
              <button type="button" onClick={() => setDropCreating(true)}
                style={{ marginTop:10, background:"none", border:"none", padding:0, color:"#2563eb", fontSize:13, fontWeight:600, cursor:"pointer" }}>
                + Unit not on the list? Create it
              </button>
            ) : (
              <div style={{ marginTop:12, padding:12, border:"1px solid #e5e7eb", borderRadius:10, background:"#fafafa" }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#555", marginBottom:8 }}>New storage unit</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <Field label="Company"><input style={inp} list="brands-list" value={dropNewUnit.brand} onChange={e => setDropNewUnit(f => ({ ...f, brand:e.target.value }))} placeholder="CubeSmart..." /></Field>
                  <Field label="Unit #"><input style={inp} value={dropNewUnit.unit} onChange={e => setDropNewUnit(f => ({ ...f, unit:e.target.value }))} placeholder="G13" /></Field>
                  <Field label="State"><input style={inp} list="states-list" value={dropNewUnit.state} onChange={e => setDropNewUnit(f => ({ ...f, state:e.target.value.toUpperCase() }))} placeholder="TN" /></Field>
                  <Field label="Tamano"><input style={inp} list="sizes-list" value={dropNewUnit.size} onChange={e => setDropNewUnit(f => ({ ...f, size:e.target.value }))} placeholder="10x10" /></Field>
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:10 }}>
                  <Btn onClick={() => { setDropCreating(false); setDropNewUnit({ brand:"", unit:"", state:"", size:"" }); }}>Cancel</Btn>
                  <Btn primary disabled={dropCreatingBusy || !dropNewUnit.brand.trim() || !dropNewUnit.unit.trim()} onClick={createDropUnit}>{dropCreatingBusy ? "Creating…" : "Create & select"}</Btn>
                </div>
              </div>
            )}
          </Modal>
        );
      })()}

      {splitJobRow && (() => {
        const total = effCf(splitJobRow);
        const p = Number(splitCf);
        const valid = isFinite(p) && p > 0 && p < total;
        const remainder = valid ? total - p : total;
        const closeSplit = () => { setSplitJobRow(null); setSplitCf(""); setSplitDest(""); };
        // Where can the peeled portion go: any active trip except the source's own,
        // plus a brand-new trip on any free truck.
        const destTrips = trips.filter(t => TRIP_ACTIVE(t.status) && t.id !== splitJobRow.trip_id)
          .map(t => { const c = tripCalc(t); return { t, free: c.cap > 0 ? Math.round(c.cap - c.loadedCf) : null }; });
        // Free CF at the chosen destination (null = unknown capacity), for an overload hint.
        let destFree = null;
        if (splitDest.startsWith("trip:")) destFree = destTrips.find(d => d.t.id === Number(splitDest.slice(5)))?.free ?? null;
        else if (splitDest.startsWith("truck:")) { const cap = numv(truckById[Number(splitDest.slice(6))]?.capacity_cf); destFree = cap > 0 ? cap : null; }
        const overloads = valid && destFree != null && p > destFree;
        return (
          <Modal title={trAI("Split job across two trucks", "Dividir job en dos camiones")} onClose={closeSplit}
            footer={<>
              <Btn onClick={closeSplit}>{trAI("Cancel", "Cancelar")}</Btn>
              <Btn primary disabled={tripBusy || !valid} onClick={() => splitJob(splitJobRow, p, splitDest)}>{tripBusy ? "…" : (splitDest.startsWith("truck:") ? trAI("Split & create trip", "Dividir y crear trip") : trAI("Split", "Dividir"))}</Btn>
            </>}>
            <div style={{ fontSize:13, marginBottom:10 }}>
              <b style={{ fontFamily:"monospace" }}>{splitJobRow.job_number || "(job)"}</b> · {splitJobRow.customer || "—"}
              <div style={{ color:"#666", marginTop:4 }}>{trAI("Current load", "Carga actual")}: <b>{Math.round(total).toLocaleString()} CF</b>{hasRealCf(splitJobRow) ? " ✓real" : ` (${trAI("estimate", "estimado")})`}</div>
            </div>
            <Field label={trAI("CF to move to the second truck", "CF a mover al segundo camión")} full>
              <input style={inp} type="number" min="1" max={Math.round(total) - 1} value={splitCf} onChange={e => setSplitCf(e.target.value)} autoFocus />
            </Field>
            <div style={{ fontSize:12.5, color: valid ? "#333" : "#A32D2D", marginTop:8 }}>
              {valid
                ? <>{trAI("Stays on this job", "Queda en este job")}: <b>{Math.round(remainder).toLocaleString()} CF</b> · {trAI("moves to new portion", "se mueve a la nueva porción")}: <b>{Math.round(p).toLocaleString()} CF</b></>
                : trAI(`Enter a value between 1 and ${Math.round(total) - 1} CF.`, `Ingresá un valor entre 1 y ${Math.round(total) - 1} CF.`)}
            </div>
            <Field label={trAI("Send the new portion to", "Mandar la nueva porción a")} full>
              <select style={inp} value={splitDest} onChange={e => setSplitDest(e.target.value)}>
                <option value="">{trAI("— Leave unassigned (add later) —", "— Dejar sin asignar (agregar después) —")}</option>
                {destTrips.length > 0 && (
                  <optgroup label={trAI("Existing trips", "Trips existentes")}>
                    {destTrips.map(({ t, free }) => (
                      <option key={t.id} value={"trip:" + t.id}>
                        {t.trip_number || "#" + t.id}{truckById[t.truck_id]?.name ? ` · ${truckById[t.truck_id].name}` : ""}{free != null ? ` · ${free.toLocaleString()} CF ${trAI("free", "libres")}` : ""}
                      </option>
                    ))}
                  </optgroup>
                )}
                {freeTrucks.length > 0 && (
                  <optgroup label={trAI("Create a new trip on", "Crear un trip nuevo en")}>
                    {freeTrucks.map(tk => (
                      <option key={tk.id} value={"truck:" + tk.id}>🆕 {tk.name || "Truck #" + tk.id} · {numv(tk.capacity_cf).toLocaleString()} CF</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>
            {overloads && (
              <div style={{ fontSize:11.5, color:"#A32D2D", marginTop:6 }}>
                ⚠️ {trAI(`This portion (${Math.round(p).toLocaleString()} CF) is over the destination's ${destFree.toLocaleString()} CF free — it will be over capacity.`,
                        `Esta porción (${Math.round(p).toLocaleString()} CF) supera los ${destFree.toLocaleString()} CF libres del destino — quedará sobre capacidad.`)}
              </div>
            )}
            <div style={{ fontSize:11.5, color:"#888", marginTop:10 }}>
              {trAI("The new portion keeps the same job number and is billed as one job. Leave it unassigned to add it from a trip's job picker later.",
                    "La nueva porción mantiene el mismo número de job y se factura como uno solo. Dejala sin asignar para agregarla después desde el buscador de un trip.")}
            </div>
          </Modal>
        );
      })()}

      {showTripModal && (() => {
        // Live capacity as jobs are added (using the form's selected jobs).
        const cap = numv(trucksList.find(tk => tk.id === Number(tripForm.truck_id))?.capacity_cf);
        let loadCf = 0; const seen = new Set();
        for (const j of jobs) { const k = tripUnitKey(j); if (tripForm.job_keys.includes(k) && !seen.has(k)) { seen.add(k); loadCf += effCf(j); } }
        const remaining = cap > 0 ? cap - loadCf : null;
        const pct = cap > 0 ? Math.min(100, Math.round((loadCf / cap) * 100)) : 0;
        const repFor = (k) => jobs.find(j => tripUnitKey(j) === k);
        return (
        <Modal title={editingTripId ? "Edit trip" : "New trip"} onClose={() => setShowTripModal(false)}
          footer={<>
            <Btn onClick={() => setShowTripModal(false)}>Cancel</Btn>
            {editingTripId && <Btn danger onClick={() => { setShowTripModal(false); deleteTrip(trips.find(x=>x.id===editingTripId)); }}>Delete</Btn>}
            <Btn primary disabled={tripSaving} onClick={saveTrip}>{tripSaving ? "Saving..." : (editingTripId ? "Save changes" : "Create trip")}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Trip number"><input style={inp} value={tripForm.trip_number} onChange={e => setTripForm(f => ({...f, trip_number:e.target.value}))} placeholder="TRIP-001" /></Field>
            <Field label="Departure date"><input style={inp} type="date" value={tripForm.departure_date} onChange={e => setTripForm(f => ({...f, departure_date:e.target.value}))} /></Field>
            <Field label="Truck">
              <select style={inp} value={tripForm.truck_id} onChange={e => setTripForm(f => ({...f, truck_id:e.target.value}))}>
                <option value="">— No truck —</option>{trucksList.map(tk => <option key={tk.id} value={tk.id}>{tk.name}{tk.capacity_cf ? ` · ${Number(tk.capacity_cf).toLocaleString()} CF` : ""}</option>)}
              </select>
            </Field>
            <Field label="Driver">
              <select style={inp} value={tripForm.driver_id} onChange={e => setTripForm(f => ({...f, driver_id:e.target.value}))}>
                <option value="">— No driver —</option>{driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Status" full>
              {editingTripId ? (() => {
                const st = tripForm.status || "loading";
                return (
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <TripBadge status={st} />
                    {st === "loading" && <Btn onClick={() => setEditTripStatus("in_transit")}>Mark as In Transit</Btn>}
                    {st === "in_transit" && <>
                      <Btn onClick={() => setEditTripStatus("loading")}>Mark as Loading</Btn>
                      <Btn primary onClick={() => setEditTripStatus("completed")}>Mark as Completed</Btn>
                    </>}
                    {st === "completed" && <Btn onClick={() => setEditTripStatus("in_transit")}>Reopen (mark as In Transit)</Btn>}
                    {st === "cancelled" && <Btn onClick={() => setEditTripStatus("loading")}>Reopen (mark as Loading)</Btn>}
                    {st !== "cancelled" && <Btn danger onClick={() => setEditTripStatus("cancelled")}>Cancel Trip</Btn>}
                  </div>
                );
              })() : (
                <div style={{ ...inp, display:"flex", alignItems:"center", gap:8, background:"#fafafa", color:"#888" }}>
                  <TripBadge status="loading" />
                  <span style={{ fontSize:11 }}>New trips start as Loading</span>
                </div>
              )}
            </Field>
          </div>

          <div style={{ background: cap > 0 && pct > 90 ? "#FCEBEB" : "#f7f7f7", borderRadius:8, padding:"10px 12px", marginTop:12 }}>
            {cap > 0 ? (
              <>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:5 }}>
                  <b style={{ color: occColor(pct) }}>{pct}% · {Math.round(loadCf).toLocaleString()} CF</b>
                  <span style={{ color: remaining < 0 ? "#A32D2D" : "#888" }}>{Math.round(remaining).toLocaleString()} CF left</span>
                </div>
                <div style={{ background:"#e8e8e8", borderRadius:6, height:10, overflow:"hidden" }}><div style={{ background:occColor(pct), height:10, width:`${pct}%` }} /></div>
              </>
            ) : <div style={{ fontSize:12, color:"#888" }}>Set the truck capacity to see occupancy · {Math.round(loadCf).toLocaleString()} CF selected</div>}
          </div>

          <SectionLabel>Stops — delivery order{tripForm.job_keys.length ? ` (${tripForm.job_keys.length})` : ""}</SectionLabel>
          {tripForm.job_keys.length > 0 && (
            <div style={{ border:"1px solid #e5e5e5", borderRadius:8, marginBottom:8 }}>
              {tripForm.job_keys.map((k, i) => { const j = repFor(k); if (!j) return null; return (
                <div key={k} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", borderBottom:"1px solid #f5f5f5", fontSize:13 }}>
                  <span style={{ width:20, height:20, borderRadius:"50%", background:"#111", color:"#fff", fontSize:10, fontWeight:700, display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{i+1}</span>
                  <span style={{ fontFamily:"monospace", fontWeight:600 }}>{j.job_number || "(job)"}</span>
                  {j.split_group && <span style={{ fontSize:10, color:"#7C3AED", fontWeight:700 }} title="Split load — one portion of this job">✂️ {splitLabel(j)}</span>}
                  <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.customer || "—"}</span>
                  {!tripPurposeColMissing && (() => {
                    const isReloc = tripForm.purposes?.[k] === "relocation";
                    return (
                      <button onClick={() => setTripForm(f => ({ ...f, purposes: { ...f.purposes, [k]: isReloc ? "delivery" : "relocation" } }))}
                        title={trAI("Toggle: delivery vs internal relocation (no delivery, no collection)", "Alternar: delivery vs reubicación interna (sin delivery, sin cobro)")}
                        style={{ border:"none", cursor:"pointer", fontSize:10, fontWeight:700, borderRadius:20, padding:"2px 8px", whiteSpace:"nowrap",
                          background: isReloc ? "#E6F1FB" : "#EDE9FE", color: isReloc ? "#185FA5" : "#6D28D9" }}>
                        {isReloc ? "🔁 Relocation" : "🚚 Delivery"}
                      </button>
                    );
                  })()}
                  <span style={{ color:"#888" }}>{Math.round(effCf(j))} CF{hasRealCf(j) ? " ✓" : ""}</span>
                  <FaddBadge fadd={j.fadd} />
                  <button onClick={() => tripMoveJob(i, -1)} disabled={i===0} style={{ border:"none", background:"none", cursor: i===0?"default":"pointer", color: i===0?"#ddd":"#888", fontSize:14 }}>↑</button>
                  <button onClick={() => tripMoveJob(i, 1)} disabled={i===tripForm.job_keys.length-1} style={{ border:"none", background:"none", cursor: i===tripForm.job_keys.length-1?"default":"pointer", color: i===tripForm.job_keys.length-1?"#ddd":"#888", fontSize:14 }}>↓</button>
                  <button onClick={() => tripToggleJob(k)} style={{ border:"none", background:"none", cursor:"pointer", color:"#E24B4A" }}>×</button>
                </div>
              ); })}
            </div>
          )}
          <input style={{ ...inp, marginBottom:8 }} value={tripJobSearch} onChange={e => setTripJobSearch(e.target.value)} placeholder="Search job # / client / storage to add..." />
          <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:180, overflowY:"auto", background:"#fff" }}>
            {(() => {
              const q = tripJobSearch.trim().toLowerCase();
              if (!q) return <div style={{ padding:"10px 12px", fontSize:12, color:"#bbb" }}>Search for a job to add it to the trip.</div>;
              const seen2 = new Set(); const rows = [];
              for (const j of jobs) { const k = tripUnitKey(j); if (seen2.has(k)) continue; seen2.add(k);
                const s = storageById[j.storage_id] || {};
                const hay = [j.job_number, j.customer, j.driver, s.brand, s.unit].join(" ").toLowerCase();
                if (!hay.includes(q)) continue;
                const otherTrip = j.trip_id && j.trip_id !== editingTripId ? tripById[j.trip_id] : null;
                rows.push({ j, k, otherTrip });
              }
              if (!rows.length) return <div style={{ padding:"10px 12px", fontSize:12, color:"#bbb" }}>No results.</div>;
              return rows.slice(0, 50).map(({ j, k, otherTrip }) => {
                const checked = tripForm.job_keys.includes(k);
                return (
                  <label key={k} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked?"#f0fdf4":"#fff" }}>
                    <input type="checkbox" checked={checked} onChange={() => tripToggleJob(k)} />
                    <span style={{ fontFamily:"monospace", fontWeight:600 }}>{j.job_number || "(job)"}</span>
                    {j.split_group && <span style={{ fontSize:10, color:"#7C3AED", fontWeight:700 }} title="Split load — one portion of this job">✂️ {splitLabel(j)}</span>}
                    <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.customer || "—"}</span>
                    <span style={{ color:"#888" }}>{Math.round(effCf(j))} CF{hasRealCf(j) ? " ✓" : ""}</span>
                    {otherTrip && TRIP_ACTIVE(otherTrip.status) && <span style={{ fontSize:10, color:"#C2410C" }} title="On another active trip — will move here">on {otherTrip.trip_number || "#"+otherTrip.id}</span>}
                  </label>
                );
              });
            })()}
          </div>
          <Field label="Notes" full><input style={{ ...inp, marginTop:10 }} value={tripForm.notes} onChange={e => setTripForm(f => ({...f, notes:e.target.value}))} placeholder="Trip notes" /></Field>
        </Modal>
        );
      })()}

      {showTripAI && (() => {
        const live = new Set(tripCandidateJobs.map(tripUnitKey));
        const repFor = (k) => jobs.find(j => tripUnitKey(j) === k);
        const dropSuggestion = (kind, idx) => setTripAIResult(r => ({ ...r, [kind]: r[kind].filter((_, i) => i !== idx) }));
        const SuggestionCard = ({ s, kind, idx }) => {
          const truck = kind === "addition" ? truckById[tripById[s.trip_id]?.truck_id] : truckById[s.truck_id];
          const capCf = numv(truck?.capacity_cf);
          const pct = s.occ_pct ?? (capCf > 0 ? Math.round((s.total_cf / capCf) * 100) : 0);
          const title = kind === "addition"
            ? `➕ ${trAI("Add to", "Agregar a")} ${tripById[s.trip_id]?.trip_number || "#" + s.trip_id}${truck?.name ? ` (${truck.name})` : ""}`
            : `🚚 ${trAI("New trip", "Nuevo trip")} — ${truck?.name || "Truck #" + s.truck_id}`;
          return (
            <div style={{ border:"1px solid #e5e5e5", borderRadius:10, padding:"12px 14px", marginBottom:10, background:"#fff" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, gap:8 }}>
                <b style={{ fontSize:13 }}>{title}</b>
                <span style={{ fontSize:12, fontWeight:700, color: occColor(pct), flexShrink:0 }}>{pct}% · {Math.round(s.total_cf).toLocaleString()} CF{capCf > 0 ? ` / ${Math.round(capCf).toLocaleString()} CF` : ""}</span>
              </div>
              <div style={{ background:"#e8e8e8", borderRadius:6, height:8, overflow:"hidden", marginBottom:8 }}><div style={{ background:occColor(pct), height:8, width:`${Math.min(100, pct)}%` }} /></div>
              <div style={{ border:"1px solid #f0f0f0", borderRadius:8 }}>
                {s.job_keys.map((k, i) => {
                  const j = repFor(k); const stale = !live.has(k);
                  return (
                    <div key={k} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", borderBottom:"1px solid #f7f7f7", fontSize:12, textDecoration: stale ? "line-through" : "none", color: stale ? "#bbb" : "#333" }}>
                      <span style={{ width:18, height:18, borderRadius:"50%", background: stale ? "#ccc" : "#111", color:"#fff", fontSize:10, fontWeight:700, display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{i+1}</span>
                      <span style={{ fontFamily:"monospace", fontWeight:600 }}>{j?.job_number || k}</span>
                      <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j?.customer || "—"}</span>
                      {j && <span style={{ color:"#888", flexShrink:0 }}>{Math.round(effCf(j))} CF</span>}
                      {j && <span style={{ color:"#888", flexShrink:0, maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{jobOrigin(j, storageById)?.label || ""} → {[j.delivery_city, j.delivery_state].filter(Boolean).join(", ") || "?"}</span>}
                      {j && !stale && <FaddBadge fadd={j.fadd} />}
                      {stale && <span style={{ fontSize:10, color:"#C2410C", textDecoration:"none", flexShrink:0 }}>no longer available</span>}
                    </div>
                  );
                })}
              </div>
              {s.reasoning && (
                <div style={{ display:"flex", gap:8, alignItems:"flex-start", background:"#FFFBEB", border:"1px solid #FDE9C8", borderRadius:8, padding:"8px 10px", marginTop:8, fontSize:12, color:"#854F0B", lineHeight:1.5 }}>
                  <span style={{ flexShrink:0 }}>💡</span>
                  <span><b>Why this trip:</b> {s.reasoning}</span>
                </div>
              )}
              <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:10 }}>
                <Btn onClick={() => dropSuggestion(kind === "addition" ? "trip_additions" : "new_trips", idx)}>Dismiss</Btn>
                <Btn primary onClick={() => applyTripSuggestion(s, kind)}>{kind === "addition" ? "Review & add" : "Review & create"}</Btn>
              </div>
            </div>
          );
        };
        return (
        <Modal title="AI trip suggestions" onClose={() => setShowTripAI(false)}
          footer={<>
            <Btn onClick={() => setShowTripAI(false)}>Close</Btn>
            <Btn disabled={tripAILoading} onClick={requestTripSuggestions}>New suggestions</Btn>
          </>}>
          {tripAILoading && (
            <div style={{ display:"flex", alignItems:"center", gap:10, padding:"20px 0", color:"#888", fontSize:13 }}>
              <div style={{ width:16, height:16, border:"2px solid #f0f0f0", borderTop:"2px solid #111", borderRadius:"50%", animation:"spin 0.8s linear infinite", flexShrink:0 }} />
              {trAI(
                `Analyzing ${tripCandidateJobs.length} jobs and ${freeTrucks.length + loadingTripsWithRoom.length} trucks/trips...`,
                `Analizando ${tripCandidateJobs.length} jobs y ${freeTrucks.length + loadingTripsWithRoom.length} camiones/trips...`)}
            </div>
          )}
          {!tripAILoading && tripAIError && (
            <div style={{ padding:"14px", background:"#FCEBEB", border:"1px solid #F2C4C4", borderRadius:8, fontSize:13, color:"#A32D2D", marginBottom:10 }}>{tripAIError}</div>
          )}
          {!tripAILoading && !tripAIError && tripAIResult && (
            <>
              {tripAIResult.new_trips.length === 0 && tripAIResult.trip_additions.length === 0 && (
                <div style={{ padding:"14px 0", fontSize:13, color:"#888" }}>{trAI(
                  "The AI found no recommendable groupings with the current jobs and trucks.",
                  "La IA no encontró agrupaciones recomendables con los jobs y camiones actuales.")}</div>
              )}
              {tripAIResult.new_trips.map((s, idx) => <SuggestionCard key={`n${s.truck_id}-${idx}`} s={s} kind="new" idx={idx} />)}
              {tripAIResult.trip_additions.map((s, idx) => <SuggestionCard key={`a${s.trip_id}-${idx}`} s={s} kind="addition" idx={idx} />)}
              {tripAIResult.unassigned.length > 0 && (
                <>
                  <SectionLabel>{trAI("Unassigned jobs", "Jobs sin asignar")} ({tripAIResult.unassigned.length})</SectionLabel>
                  <div style={{ border:"1px solid #f0f0f0", borderRadius:8, marginBottom:10 }}>
                    {tripAIResult.unassigned.map(u => { const j = repFor(u.job_key); return (
                      <div key={u.job_key} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", borderBottom:"1px solid #f7f7f7", fontSize:12 }}>
                        <span style={{ fontFamily:"monospace", fontWeight:600 }}>{j?.job_number || u.job_key}</span>
                        <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j?.customer || "—"}</span>
                        <span style={{ color:"#888", flexShrink:0 }}>{u.reason}</span>
                      </div>
                    ); })}
                  </div>
                </>
              )}
              {tripAIResult.notes && <div style={{ fontSize:12, color:"#888", marginTop:6, lineHeight:1.5 }}>{tripAIResult.notes}</div>}
            </>
          )}
        </Modal>
        );
      })()}

      {showCsModal && (
        <Modal title={editingCsId ? "Edit closing sheet" : "New closing sheet"} onClose={() => setShowCsModal(false)}
          footer={<>
            <Btn onClick={() => setShowCsModal(false)}>Cancel</Btn>
            <Btn primary disabled={csSaving} onClick={saveCs}>{csSaving ? "Saving..." : (editingCsId ? "Save changes" : "Create")}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="CS number"><input style={inp} value={csForm.closing_sheet_number} onChange={e => setCsForm(f => ({...f, closing_sheet_number:e.target.value}))} placeholder="CS-1024" /></Field>
            <Field label="Load date"><input style={inp} type="date" value={csForm.load_date} onChange={e => setCsForm(f => ({...f, load_date:e.target.value}))} /></Field>
            <Field label="Broker">
              <select style={inp} value={csForm.broker_id} onChange={e => setCsForm(f => ({...f, broker_id:e.target.value}))}>
                <option value="">— Sin broker —</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Driver">
              <select style={inp} value={csForm.driver_id} onChange={e => setCsForm(f => ({...f, driver_id:e.target.value}))}>
                <option value="">— No driver —</option>{driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select style={inp} value={csForm.status} onChange={e => setCsForm(f => ({...f, status:e.target.value}))}>
                <option value="open">Open</option><option value="settled">Settled</option><option value="disputed">Disputed</option>
              </select>
            </Field>
          </div>

          <SectionLabel>Document (photo or PDF)</SectionLabel>
          <label style={{ display:"block", border:"2px dashed #ddd", borderRadius:10, padding:"12px", textAlign:"center", cursor:"pointer", background:"#fafafa" }}
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) uploadCsDoc(f, null); }}>
            <input type="file" accept="image/*,application/pdf" style={{ display:"none" }} onChange={e => uploadCsDoc(e.target.files?.[0], null)} />
            {docUploading ? <span style={{ fontSize:12, color:"#888" }}>Subiendo…</span>
              : csForm.document_url ? <span style={{ fontSize:12, color:"#3B6D11" }}>✓ Document uploaded — click to replace</span>
              : <span style={{ fontSize:12, color:"#999" }}>Drag or click to upload</span>}
          </label>

          <SectionLabel>Jobs en este closing sheet{csForm.job_keys.length ? ` (${csForm.job_keys.length})` : ""}</SectionLabel>
          <input style={{ ...inp, marginBottom:8 }} value={csJobSearch} onChange={e => setCsJobSearch(e.target.value)} placeholder="Search job # or client to add..." />
          <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:180, overflowY:"auto", background:"#fff" }}>
            {(() => {
              const q = csJobSearch.trim().toLowerCase();
              const seen = new Set(); const rows = [];
              for (const j of jobs) { const k = jobKey(j); if (seen.has(k)) continue; seen.add(k);
                const inOther = j.closing_sheet_id && j.closing_sheet_id !== editingCsId;
                const hay = [j.job_number, j.customer, j.driver].join(" ").toLowerCase();
                if (q && !hay.includes(q)) continue;
                if (!q && !csForm.job_keys.includes(k)) continue; // when not searching, show only selected
                rows.push({ j, k, inOther });
              }
              if (!rows.length) return <div style={{ padding:"10px 12px", fontSize:12, color:"#bbb" }}>{q ? "No results." : "Search for a job to add it."}</div>;
              return rows.slice(0, 60).map(({ j, k, inOther }) => {
                const checked = csForm.job_keys.includes(k);
                return (
                  <label key={k} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor: inOther?"not-allowed":"pointer", borderBottom:"1px solid #f5f5f5", background: checked?"#f0fdf4":"#fff", opacity: inOther?0.5:1 }}>
                    <input type="checkbox" disabled={inOther} checked={checked} onChange={() => csToggleJob(k)} />
                    <span style={{ fontFamily:"monospace", fontWeight:600 }}>{j.job_number || "(job)"}</span>
                    <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.customer || "—"}</span>
                    {inOther && <span style={{ fontSize:10, color:"#999" }}>en otro CS</span>}
                  </label>
                );
              });
            })()}
          </div>

          <SectionLabel>Pads</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Missing pad charge ($)"><input style={inp} type="number" value={csForm.charge_per_pad} onChange={e => setCsForm(f => ({...f, charge_per_pad:e.target.value}))} placeholder="7" /></Field>
          </div>
          <div style={{ fontSize:11, color:"#999", marginTop:4 }}>Sent/returned pads are entered per job (job Pads section) and summed here automatically.</div>

          <SectionLabel>Deducciones del broker</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Trip cost ($)"><input style={inp} type="number" value={csForm.trip_cost} onChange={e => setCsForm(f => ({...f, trip_cost:e.target.value}))} placeholder="0" /></Field>
            <Field label="Labor charges ($)"><input style={inp} type="number" value={csForm.labor_charges} onChange={e => setCsForm(f => ({...f, labor_charges:e.target.value}))} placeholder="0" /></Field>
            <Field label="Other fees ($)"><input style={inp} type="number" value={csForm.other_fees} onChange={e => setCsForm(f => ({...f, other_fees:e.target.value}))} placeholder="0" /></Field>
            <Field label="Other fees description"><input style={inp} value={csForm.other_fees_description} onChange={e => setCsForm(f => ({...f, other_fees_description:e.target.value}))} placeholder="ej: detention" /></Field>
            <Field label="Notes" full><input style={inp} value={csForm.notes} onChange={e => setCsForm(f => ({...f, notes:e.target.value}))} placeholder="Notes" /></Field>
          </div>
          {editingCsId && <div style={{ marginTop:12 }}><Btn danger onClick={() => { setShowCsModal(false); deleteCs(closingSheets.find(x=>x.id===editingCsId)); }}>Delete closing sheet</Btn></div>}
        </Modal>
      )}

      {payModal && (
        <Modal title="Record collection (BOL)" onClose={() => setPayModal(null)}
          footer={<>
            <Btn onClick={() => setPayModal(null)}>Cancel</Btn>
            <Btn primary onClick={savePayment}>Save collection</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Amount collected ($)"><input style={inp} type="number" value={payModal.amount} onChange={e => setPayModal(p => ({...p, amount:e.target.value}))} placeholder="0" /></Field>
            <Field label="Collection date"><input style={inp} type="date" value={payModal.date} onChange={e => setPayModal(p => ({...p, date:e.target.value}))} /></Field>
            <Field label="Payment method" full>
              <PaymentMethodSelect style={inp} value={payModal.method} onChange={v => setPayModal(p => ({...p, method: v || ""}))} />
            </Field>
            <Field label="Notes" full><input style={inp} value={payModal.notes} onChange={e => setPayModal(p => ({...p, notes:e.target.value}))} placeholder="Collection notes (e.g. split cash + zelle)" /></Field>
          </div>
        </Modal>
      )}

      {(() => {
        // Shared job-list panel for broker / driver / client detail modals.
        const JobsPanel = ({ predicate }) => {
          const map = new Map();
          for (const j of jobs) { if (!predicate(j)) continue; const k = jobKey(j); if (!map.has(k)) map.set(k, j); }
          const rows = [...map.values()];
          if (!rows.length) return <div style={{ fontSize:13, color:"#bbb", padding:"10px 0" }}>No jobs.</div>;
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:8 }}>
              {rows.map(j => (
                <div key={j.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, borderBottom:"1px solid #f4f4f4", paddingBottom:6 }}>
                  <button onClick={() => { setBrokerDetailId(null); setDriverDetailId(null); setClientDetail(null); setJobDetailKey(jobKey(j)); }} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                  <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.customer || "—"}</span>
                  <StatusBadge status={j.status} />
                  {j.fadd && <span style={{ fontSize:11, color:"#888" }}>{j.fadd}</span>}
                </div>
              ))}
            </div>
          );
        };
        const brokerD = brokers.find(b => b.id === brokerDetailId);
        const driverD = driversList.find(d => d.id === driverDetailId);
        return (
          <>
            {brokerD && (
              <Modal title={`Broker · ${brokerD.name}`} onClose={() => setBrokerDetailId(null)} footer={<Btn primary onClick={() => setBrokerDetailId(null)}>Close</Btn>}>
                <DetailRow label="Contact" value={brokerD.contact_name} />
                <DetailRow label="Phone" value={brokerD.contact_phone} />
                <DetailRow label="Email" value={brokerD.contact_email} />
                <SectionLabel>Jobs del broker</SectionLabel>
                <JobsPanel predicate={j => j.broker_id === brokerD.id} />
              </Modal>
            )}
            {driverD && (
              <Modal title={`Driver · ${driverD.name}`} onClose={() => setDriverDetailId(null)} footer={<Btn primary onClick={() => setDriverDetailId(null)}>Close</Btn>}>
                <DetailRow label="Phone" value={driverD.phone} />
                <DetailRow label="Truck" value={driverD.truck_id} />
                {driverD.whatsapp_group_link && <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}><span style={{ color:"#888", minWidth:150 }}>Grupo WhatsApp</span><a href={driverD.whatsapp_group_link} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E", textDecoration:"none" }}>Open group ↗</a></div>}
                {!paymentsMissing && (() => {
                  const mine = paymentRows.filter(p => [p.cash_with_whom, p.received_by].some(v => (v || "").trim() && (v || "").trim() === driverD.name));
                  const holding = mine.filter(p => isPhysical(p.method) && p.received && !p.banked);
                  const heldTotal = holding.reduce((s, p) => s + p._net, 0);
                  const history = mine.filter(p => p.received).sort((a, b) => (b.received_date || b.payment_date || "").localeCompare(a.received_date || a.payment_date || ""));
                  return (
                    <>
                      <SectionLabel>In circulation</SectionLabel>
                      <div style={{ display:"flex", alignItems:"center", gap:10, fontSize:13, marginBottom:6 }}>
                        <span>Tiene en mano: <b style={{ color: heldTotal > 0 ? "#E24B4A" : "#1A8A4E", fontSize:15 }}>${Math.round(heldTotal).toLocaleString()}</b></span>
                        {heldTotal > 0 && <span style={{ fontSize:11, color:"#888" }}>({holding.length} pago{holding.length !== 1 ? "s" : ""} sin depositar)</span>}
                      </div>
                      <SectionLabel>Historial de pagos recibidos</SectionLabel>
                      {history.length === 0 ? <div style={{ fontSize:13, color:"#bbb", padding:"4px 0" }}>Sin pagos recibidos.</div>
                        : <div style={{ maxHeight:200, overflowY:"auto" }}>{history.map(p => (
                            <div key={p.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:"1px solid #f4f4f4", fontSize:12.5, flexWrap:"wrap" }}>
                              <button onClick={() => { setDriverDetailId(null); if (p._key) setJobDetailKey(p._key); }} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{p._g?.job_number || "(ver)"}</button>
                              <PaymentMethodBadge method={p.method} />
                              <b>${p._net.toLocaleString()}</b>
                              <span style={{ color:"#888" }}>recibido {p.received_date || p.payment_date || "—"}</span>
                              <span style={{ flex:1 }} />
                              {p.banked ? <span style={{ fontSize:10.5, fontWeight:700, color:"#185FA5" }}>depositado {p.banked_date || ""}</span> : <span style={{ fontSize:10.5, fontWeight:700, color:"#C2410C" }}>sin depositar</span>}
                            </div>
                          ))}</div>}
                    </>
                  );
                })()}
                <SectionLabel>Historial de jobs</SectionLabel>
                <JobsPanel predicate={j => (Array.isArray(j.driver_ids) && j.driver_ids.includes(driverD.id)) || (j.driver && driverD.name && j.driver.includes(driverD.name))} />
              </Modal>
            )}
            {clientDetail && (
              <Modal title={`Client · ${clientDetail}`} onClose={() => setClientDetail(null)} footer={<Btn primary onClick={() => setClientDetail(null)}>Close</Btn>}>
                <SectionLabel>Client jobs</SectionLabel>
                <JobsPanel predicate={j => (j.customer || "").trim().toLowerCase() === clientDetail.trim().toLowerCase()} />
              </Modal>
            )}
          </>
        );
      })()}

      {payPhotoView && (
        <div onClick={() => setPayPhotoView(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", zIndex:60, display:"flex", alignItems:"center", justifyContent:"center", padding:24, cursor:"zoom-out" }}>
          {payPhotoView.toLowerCase().includes(".pdf")
            ? <div style={{ background:"#fff", borderRadius:10, padding:24, textAlign:"center" }}><div style={{ fontSize:40 }}>📄</div><a href={payPhotoView} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color:"#185FA5" }}>Open PDF in new tab ↗</a></div>
            : <img src={payPhotoView} alt="documento" style={{ maxWidth:"92%", maxHeight:"92%", borderRadius:8, boxShadow:"0 8px 40px rgba(0,0,0,0.4)" }} onClick={e => e.stopPropagation()} />}
        </div>
      )}

      {toast && (
        <div style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)", zIndex:100, background:"#111", color:"#fff", fontSize:13.5, fontWeight:600, padding:"11px 20px", borderRadius:10, boxShadow:"0 6px 24px rgba(0,0,0,0.25)", display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:"#7ED957" }}>✓</span>{toast}
        </div>
      )}
    </div>
  );
}
