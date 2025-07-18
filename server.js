require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;
const KOMMO_PHONE_FIELD_CODE = process.env.KOMMO_PHONE_FIELD_CODE;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const KOMMO_TARGET_STAGES_STRING = process.env.KOMMO_TARGET_STAGES || '';
const TARGET_STAGES = KOMMO_TARGET_STAGES_STRING.split(',').map(stage => stage.trim());

if (!SPREADSHEET_ID || !SHEET_NAME || !KOMMO_SUBDOMAIN || !KOMMO_ACCESS_TOKEN || !KOMMO_PHONE_FIELD_CODE || TARGET_STAGES.length === 0 || TARGET_STAGES[0] === '') {
    console.error("ERRO: Uma ou mais variáveis de ambiente essenciais não foram definidas. Verifique seu arquivo .env.");
    process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const processingLeads = new Set();

function getFieldValueByCode(customFields, fieldCode) {
    if (!customFields || !Array.isArray(customFields)) return '';
    const field = customFields.find(f => f.field_code === fieldCode);
    return field?.values?.[0]?.value || '';
}

function formatUnixTimestamp(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function getFullLeadDetails(leadId) {
    const leadUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}?with=contacts`;
    try {
        const leadResponse = await axios.get(leadUrl, {
            headers: { 'Authorization': `Bearer ${KOMMO_ACCESS_TOKEN}` }
        });
        const lead = leadResponse.data;
        const mainContactId = lead._embedded?.contacts?.[0]?.id;
        if (mainContactId) {
            const contactUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/contacts/${mainContactId}`;
            const contactResponse = await axios.get(contactUrl, {
                headers: { 'Authorization': `Bearer ${KOMMO_ACCESS_TOKEN}` }
            });
            lead.contact_custom_fields = contactResponse.data.custom_fields_values;
        }
        if (!lead.pipeline_id) return lead;
        const pipelineUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/pipelines/${lead.pipeline_id}`;
        const pipelineResponse = await axios.get(pipelineUrl, {
            headers: { 'Authorization': `Bearer ${KOMMO_ACCESS_TOKEN}` }
        });
        const pipeline = pipelineResponse.data;
        const status = pipeline?._embedded?.statuses?.find(s => s.id == lead.status_id);
        lead.pipeline_name = pipeline?.name || 'Funil não encontrado';
        lead.status_label = status?.name || 'Etapa não encontrada';
        return lead;
    } catch (error) {
        console.error(`Erro ao buscar dados completos do lead ${leadId}:`, error.response?.data || error.message);
        throw new Error('Falha ao buscar dados na API da Kommo.');
    }
}

app.post('/webhook', (req, res) => {
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

        if (!TARGET_STAGES.includes(fullLead.status_label)) {
            return;
        }

        console.log(`>>> INICIANDO PROCESSAMENTO: Lead ID ${leadId} na etapa '${fullLead.status_label}'`);

        const sheetData = {
            id_lead: fullLead.id,
            nome_lead: fullLead.name,
            numero_cliente: getFieldValueByCode(fullLead.contact_custom_fields, KOMMO_PHONE_FIELD_CODE),
            preco: fullLead.price || 0,
            nome_funil: fullLead.pipeline_name,
            etapa_lead: fullLead.status_label,
            data_criacao: formatUnixTimestamp(fullLead.created_at),
            data_ultima_atualizacao: formatUnixTimestamp(fullLead.updated_at),
        };

        const auth = new google.auth.GoogleAuth({
            keyFile: 'webhook-dilasoleng-6b945ac2ec0a.json',
            scopes: 'https://www.googleapis.com/auth/spreadsheets',
        });
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        
        const rangeToSearch = `${SHEET_NAME}!A:A`;
        const searchResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: rangeToSearch,
        });
        const rows = searchResponse.data.values || [];
        let rowIndex = rows.findIndex(row => row[0] == sheetData.id_lead) + 1;

        const newRowValues = [
            sheetData.id_lead, sheetData.nome_lead, sheetData.numero_cliente,
            sheetData.preco, sheetData.nome_funil, sheetData.etapa_lead,
            sheetData.data_criacao, sheetData.data_ultima_atualizacao,
        ];

        if (rowIndex > 0) {
            console.log(`    Atualizando linha ${rowIndex} para o lead ID ${sheetData.id_lead}`);
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowIndex}`,
                valueInputOption: 'USER_ENTERED', resource: { values: [newRowValues] },
            });
        } else {
            console.log(`    Criando nova linha para o lead ID ${sheetData.id_lead}`);
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1`,
                valueInputOption: 'USER_ENTERED', resource: { values: [newRowValues] },
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