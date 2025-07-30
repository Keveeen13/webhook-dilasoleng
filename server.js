require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const PORT = process.env.PORT || 4444;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;
const KOMMO_PHONE_FIELD_CODE = process.env.KOMMO_PHONE_FIELD_CODE;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const KOMMO_TARGET_STAGES_STRING = process.env.KOMMO_TARGET_STAGES || '';
const TARGET_STAGES = KOMMO_TARGET_STAGES_STRING.split(',').map(stage => stage.trim());
const KOMMO_LEAD_CUSTOM_FIELDS_STRING = process.env.KOMMO_LEAD_CUSTOM_FIELDS || '';
const LEAD_CUSTOM_FIELDS = KOMMO_LEAD_CUSTOM_FIELDS_STRING.split(',').map(field => field.trim()).filter(field => field);

if (!SPREADSHEET_ID || !SHEET_NAME || !KOMMO_SUBDOMAIN || !KOMMO_ACCESS_TOKEN || !KOMMO_PHONE_FIELD_CODE || TARGET_STAGES.length === 0 || TARGET_STAGES[0] === '') {
    console.error("ERRO: Uma ou mais variáveis de ambiente essenciais não foram definidas. Verifique seu arquivo .env.");
    process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const processingLeads = new Set();

function getFieldValue(customFields, fieldIdentifier, by = 'name') {
    if (!customFields || !Array.isArray(customFields)) return '';
    const key = by === 'code' ? 'field_code' : 'field_name';
    const field = customFields.find(f => f[key] === fieldIdentifier);

    if (!field || !field.values) return '';

    if (field.field_type === 'multiselect') {
        return field.values.map(item => item.value).join(', ');
    }

    // // --- INÍCIO DO BLOCO DE DEBUG DOS CAMPOS ---
    // console.log(`--- DEBUG: Analisando o campo customizado encontrado: "${fieldIdentifier}" ---`);
    // console.log('Objeto completo do campo:', JSON.stringify(field, null, 2));
    // console.log('--- FIM DO DEBUG ---');
    // // ---

    const rawValue = field.values?.[0]?.value || '';

    // Se o campo for do tipo data ou aniversário e tiver um valor, formata-o.
    if ((field.field_type === 'date' || field.field_type === 'birthday') && rawValue) {
        return formatUnixTimestamp(rawValue);
    }
    
    return rawValue;
}

function formatUnixTimestamp(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function getFullLeadDetails(leadId) {
    const leadUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}?with=contacts`;
    try {
        const leadResponse = await axios.get(leadUrl, { headers: { 'Authorization': `Bearer ${KOMMO_ACCESS_TOKEN}` } });
        const lead = leadResponse.data;

        const mainContactId = lead._embedded?.contacts?.[0]?.id;
        if (mainContactId) {
            const contactUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/contacts/${mainContactId}`;
            const contactResponse = await axios.get(contactUrl, { headers: { 'Authorization': `Bearer ${KOMMO_ACCESS_TOKEN}` } });
            lead.contact_custom_fields = contactResponse.data.custom_fields_values;
        }

        if (lead.pipeline_id) {
            const pipelineUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/pipelines/${lead.pipeline_id}`;
            const pipelineResponse = await axios.get(pipelineUrl, { headers: { 'Authorization': `Bearer ${KOMMO_ACCESS_TOKEN}` } });
            const pipeline = pipelineResponse.data;
            const status = pipeline?._embedded?.statuses?.find(s => s.id == lead.status_id);
            lead.pipeline_name = pipeline?.name || 'Funil não encontrado';
            lead.status_label = status?.name || 'Etapa não encontrada';
        }
        
        if (lead.responsible_user_id) {
            console.log(`Buscando nome do usuário ID: ${lead.responsible_user_id}`);
            const userUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/users/${lead.responsible_user_id}`;
            const userResponse = await axios.get(userUrl, { headers: { 'Authorization': `Bearer ${KOMMO_ACCESS_TOKEN}` } });
            lead.responsible_user_name = userResponse.data.name;
        }

        return lead;
    } catch (error) {
        console.error(`Erro ao buscar dados completos do lead ${leadId}:`, error.response?.data || error.message);
        throw new Error('Falha ao buscar dados na API da Kommo.');
    }
}

app.post('/webhook-dilasoleng', (req, res) => {
    const notificationData = req.body.leads?.status?.[0] || req.body.leads?.add?.[0] || req.body.leads?.update?.[0];
    if (!notificationData || !notificationData.id) {
        return res.status(400).send('Webhook inválido ou sem ID de lead.');
    }

    const leadId = notificationData.id;
    res.status(200).send({ status: "received" });

    if (processingLeads.has(leadId)) {
        return;
    }

    processLead(leadId);
});

async function processLead(leadId) {
    processingLeads.add(leadId);
    try {
        const fullLead = await getFullLeadDetails(leadId);
        if (!TARGET_STAGES.includes(fullLead.status_label)) return;

        console.log(`>>> INICIANDO PROCESSAMENTO: Lead ID ${leadId} na etapa '${fullLead.status_label}'`);

        const customFieldValues = LEAD_CUSTOM_FIELDS.map(fieldName => {
            return getFieldValue(fullLead.custom_fields_values, fieldName, 'name');
        });

        const sheetData = {
            id_lead: fullLead.id,
            nome_lead: fullLead.name,
            numero_cliente: getFieldValue(fullLead.contact_custom_fields, KOMMO_PHONE_FIELD_CODE, 'code'),
            preco: fullLead.price || 0,
            nome_funil: fullLead.pipeline_name,
            etapa_lead: fullLead.status_label,
            data_criacao: formatUnixTimestamp(fullLead.created_at),
            data_ultima_atualizacao: formatUnixTimestamp(fullLead.updated_at),
            usuario_responsavel: fullLead.responsible_user_name || '',
        };

        const newRowValues = [
            sheetData.id_lead,
            sheetData.nome_lead,
            sheetData.numero_cliente,
            sheetData.preco,
            sheetData.nome_funil,
            sheetData.etapa_lead,
            sheetData.data_criacao,
            sheetData.data_ultima_atualizacao,
            sheetData.usuario_responsavel,
            ...customFieldValues
        ];

        const auth = new google.auth.GoogleAuth({ keyFile: 'webhook-dilasoleng-6b945ac2ec0a.json', scopes: 'https://www.googleapis.com/auth/spreadsheets' });
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        
        const rangeToSearch = `${SHEET_NAME}!A:A`;
        const searchResponse = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: rangeToSearch });
        const rows = searchResponse.data.values || [];
        let rowIndex = rows.findIndex(row => row[0] == sheetData.id_lead) + 1;

        if (rowIndex > 0) {
            console.log(`    Atualizando linha ${rowIndex} para o lead ID ${sheetData.id_lead}`);
            await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowIndex}`, valueInputOption: 'USER_ENTERED', resource: { values: [newRowValues] } });
        } else {
            console.log(`    Criando nova linha para o lead ID ${sheetData.id_lead}`);
            const nextRow = rows.length + 1;
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A${nextRow}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [newRowValues] },
            });
        }
        console.log(`<<< PROCESSAMENTO FINALIZADO COM SUCESSO: Lead ID ${leadId}`);

    } catch (error) {
        console.error(`ERRO AO PROCESSAR O LEAD ID ${leadId}:`, error.message);
    } finally {
        processingLeads.delete(leadId);
    }
}

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});