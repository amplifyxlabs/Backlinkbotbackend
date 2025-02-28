const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const Airtable = require('airtable');
const cron = require('node-cron');
const emailService = require('./services/emailService');

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Airtable
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY; // Your personal access token
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appGZlClarU43tuUw';
Airtable.configure({
  endpointUrl: 'https://api.airtable.com',
  apiKey: AIRTABLE_API_KEY
});
const airtableBase = Airtable.base(AIRTABLE_BASE_ID);

// Table mappings between Supabase and Airtable
const TABLE_MAPPINGS = {
  payments: {
    supabaseTable: 'payments',
    airtableTable: 'Payments', // Create this table in Airtable
    keyField: 'id', // Field to use for identifying records
    fields: [
      'id', 'user_id', 'order_id', 'variant_id', 'status', 
      'amount', 'currency', 'credits', 'created_at', 'updated_at'
    ]
  },
  product_submissions: {
    supabaseTable: 'product_submissions',
    airtableTable: 'Product Submissions', // Create this table in Airtable
    keyField: 'id',
    fields: [
      'id', 'product_name', 'one_liner', 'description', 'website_url', 
      'price', 'plan_name', 'pros', 'cons', 'categories', 'email', 'password',
      'logo_url', 'screenshot_urls', 'coupon_codes', 'twitter_handle',
      'office_address', 'pricing_model', 'primary_builder', 'secondary_builder',
      'discovery_source', 'status', 'user_id', 'created_at'
    ]
  }
};

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: true, // Allow all origins in development
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Access-Control-Allow-Origin'],
  exposedHeaders: ['Access-Control-Allow-Origin'],
  credentials: true
}));

// Enable pre-flight requests for all routes
app.options('*', cors());

app.use(express.json());

// Helper function to extract text content from HTML
const extractTextContent = (html) => {
  const $ = cheerio.load(html);
  
  // Remove script and style elements
  $('script, style, iframe, noscript').remove();
  
  // Get the page title
  const title = $('title').text().trim();
  
  // Get meta description
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  
  // Get main content (prioritize main content areas)
  const mainContent = $('main, article, .content, #content, .main').text().trim();
  
  // Get headings
  const headings = [];
  $('h1, h2, h3').each((i, el) => {
    const text = $(el).text().trim();
    if (text) headings.push(text);
  });
  
  // Get paragraphs
  const paragraphs = [];
  $('p').each((i, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });
  
  // Get links
  const links = [];
  $('a').each((i, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && text && !href.startsWith('#')) {
      links.push({ href, text });
    }
  });
  
  return {
    title,
    metaDescription,
    mainContent: mainContent || $('body').text().trim(),
    headings,
    paragraphs,
    links
  };
};

// Endpoint to scrape a website
app.post('/api/scrape-website', async (req, res) => {
  const { websiteUrl, websiteName } = req.body;
  
  if (!websiteUrl) {
    return res.status(400).json({ 
      error: 'Website URL is required',
      details: 'Please provide a valid website URL'
    });
  }
  
  try {
    // Normalize URL
    let url = websiteUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    console.log('Attempting to scrape:', url); // Add logging
    
    // Fetch the website content
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    console.log('Successfully fetched website'); // Add logging
    
    // Extract content
    const content = extractTextContent(response.data);
    
    console.log('Content extracted, analyzing with GPT...'); // Add logging
    
    // Use GPT-4o to analyze the content
    const gptAnalysis = await analyzeWebsiteWithGPT(content, websiteName);
    
    console.log('GPT analysis complete'); // Add logging
    
    // Return the scraped content and GPT analysis
    res.json({ 
      content,
      gptAnalysis,
      message: 'Website successfully analyzed'
    });
  } catch (error) {
    console.error('Error details:', error); // Add detailed error logging
    res.status(500).json({ 
      error: 'Failed to scrape website',
      message: error.message,
      details: error.response?.data || 'No additional details available'
    });
  }
});

// Function to analyze website content with GPT-4o
async function analyzeWebsiteWithGPT(content, websiteName) {
  try {
    // Create a more comprehensive content summary
    const contentSummary = `
      Website Name: ${websiteName}
      Title: ${content.title}
      Description: ${content.metaDescription}
      Main Headings: ${content.headings.slice(0, 5).join(', ')}
      Content Sample: ${content.paragraphs.slice(0, 3).join(' ')}
      Key Links: ${content.links.slice(0, 5).map(l => l.text).join(', ')}
    `;
    
    const prompt = `
      You are an expert website directory analyst with deep knowledge of online directories, SEO, and digital marketing.
      
      Analyze this website content and provide a simplified submission strategy.
      
      Website Content to Analyze:
      ${contentSummary}
      
      Provide only the following information:
      1. Description (2-3 sentences explaining the website's purpose, value proposition, and unique features)
      2. Categories (3-5 most relevant categories for directory listings)
      3. Key Features (3-5 standout features or benefits)
      
      Format your response as JSON with this structure:
      {
        "description": "Detailed description here",
        "categories": ["Category 1", "Category 2", ...],
        "features": ["Feature 1", "Feature 2", ...]
      }
    `;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: "You are a website directory expert specializing in maximizing online visibility through strategic directory submissions. Provide detailed, actionable insights based on website analysis."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });
    
    const analysis = JSON.parse(response.choices[0].message.content);
    
    // Return only the simplified fields
    return {
      description: analysis.description,
      categories: analysis.categories,
      features: analysis.features,
      analysisDate: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error analyzing with GPT:', error);
    return null;
  }
}

/**
 * Syncs data from Supabase to Airtable
 * @param {string} tableKey - Key of the table in TABLE_MAPPINGS
 * @param {Date} lastSyncTime - Last sync timestamp
 * @returns {Promise<Date>} - New sync timestamp
 */
async function syncToAirtable(tableKey, lastSyncTime) {
  const mapping = TABLE_MAPPINGS[tableKey];
  const { supabaseTable, airtableTable, keyField, fields } = mapping;
  
  console.log(`Starting sync for ${supabaseTable} to Airtable...`);
  
  try {
    // Get records from Supabase that were updated since lastSyncTime
    let query = supabase
      .from(supabaseTable)
      .select(fields.join(','));
    
    if (lastSyncTime) {
      // Only get records updated since last sync
      query = query.gte('updated_at', lastSyncTime.toISOString());
    }
    
    const { data: records, error } = await query;
    
    if (error) {
      console.error(`Error fetching ${supabaseTable} records:`, error);
      return lastSyncTime;
    }
    
    console.log(`Found ${records.length} records to sync to Airtable`);
    
    // Process records in batches of 10 (Airtable API limit)
    for (let i = 0; i < records.length; i += 10) {
      const batch = records.slice(i, i + 10);
      await processAirtableBatch(airtableTable, batch, keyField);
    }
    
    return new Date(); // Return current time as new sync time
  } catch (error) {
    console.error(`Error syncing ${supabaseTable} to Airtable:`, error);
    return lastSyncTime;
  }
}

/**
 * Process a batch of records for Airtable
 * @param {string} airtableTable - Airtable table name
 * @param {Array} records - Array of records to process
 * @param {string} keyField - Field to use for identifying records
 */
async function processAirtableBatch(airtableTable, records, keyField) {
  try {
    // For each record in the batch, check if it exists in Airtable
    for (const record of records) {
      // Convert arrays to strings for Airtable
      const preparedRecord = {};
      for (const [key, value] of Object.entries(record)) {
        if (Array.isArray(value)) {
          preparedRecord[key] = JSON.stringify(value);
        } else {
          preparedRecord[key] = value;
        }
      }
      
      // Try to find existing record in Airtable
      const existingRecords = await airtableBase(airtableTable)
        .select({
          filterByFormula: `{${keyField}} = "${record[keyField]}"`,
          maxRecords: 1
        })
        .firstPage();
      
      if (existingRecords && existingRecords.length > 0) {
        // Update existing record
        await airtableBase(airtableTable).update(existingRecords[0].id, preparedRecord);
        console.log(`Updated record ${record[keyField]} in Airtable`);
      } else {
        // Create new record
        await airtableBase(airtableTable).create(preparedRecord);
        console.log(`Created record ${record[keyField]} in Airtable`);
      }
    }
  } catch (error) {
    console.error('Error processing Airtable batch:', error);
    throw error;
  }
}

// Store last sync times
let lastSyncTimes = {
  payments: null,
  product_submissions: null
};

// Setup cron job to sync every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  console.log('Running scheduled sync with Airtable...');
  
  // Sync each table
  for (const tableKey of Object.keys(TABLE_MAPPINGS)) {
    lastSyncTimes[tableKey] = await syncToAirtable(tableKey, lastSyncTimes[tableKey]);
  }
  
  console.log('Sync completed');
});

// Add API endpoint to manually trigger a sync
app.post('/api/sync-airtable', async (req, res) => {
  try {
    for (const tableKey of Object.keys(TABLE_MAPPINGS)) {
      lastSyncTimes[tableKey] = await syncToAirtable(tableKey, lastSyncTimes[tableKey]);
    }
    res.json({ success: true, message: 'Sync with Airtable completed' });
  } catch (error) {
    console.error('Error during manual sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== EMAIL TRIGGER ENDPOINTS =====

// 1. User login (first time) - Welcome email
app.post('/api/auth/welcome', async (req, res) => {
  try {
    const { userId, email, name } = req.body;
    
    if (!email) {
      if (!userId) {
        return res.status(400).json({ success: false, error: 'Either email or userId is required' });
      }
      // Get email from userId
      try {
        const userEmail = await emailService.getUserEmailById(supabase, userId);
        const { data, error } = await emailService.sendWelcomeEmail(userEmail, name);
        return res.json({ success: true, data });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    }
    
    const { data, error } = await emailService.sendWelcomeEmail(email, name);
    
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error sending welcome email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. New form submission - asking for payment
app.post('/api/submissions/payment-request', async (req, res) => {
  try {
    const { userId, submissionId } = req.body;
    
    // Get submission data
    const { data: submission, error: submissionError } = await supabase
      .from('product_submissions')
      .select('*')
      .eq('id', submissionId)
      .single();
    
    if (submissionError || !submission) {
      return res.status(404).json({ success: false, error: submissionError?.message || 'Submission not found' });
    }
    
    // Get user email
    let email = submission.email_user || submission.email;
    if (!email && userId) {
      try {
        email = await emailService.getUserEmailById(supabase, userId);
      } catch (emailError) {
        return res.status(500).json({ success: false, error: emailError.message });
      }
    }
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'User email not found' });
    }
    
    const { data, error } = await emailService.sendPaymentRequestEmail(email, submission);
    
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error sending payment request email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Payment confirmed
app.post('/api/payments/confirmed', async (req, res) => {
  try {
    const { userId, paymentId } = req.body;
    
    // Get payment data
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('*')
      .eq('id', paymentId)
      .single();
    
    if (paymentError || !payment) {
      return res.status(404).json({ success: false, error: paymentError?.message || 'Payment not found' });
    }
    
    // Get user email
    let email;
    try {
      email = await emailService.getUserEmailById(supabase, payment.user_id || userId);
    } catch (emailError) {
      return res.status(500).json({ success: false, error: emailError.message });
    }
    
    const { data, error } = await emailService.sendPaymentConfirmationEmail(email, payment);
    
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error sending payment confirmation email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Submission verification started
app.post('/api/submissions/verification-started', async (req, res) => {
  try {
    const { userId, submissionId } = req.body;
    
    // Get submission data
    const { data: submission, error: submissionError } = await supabase
      .from('product_submissions')
      .select('*')
      .eq('id', submissionId)
      .single();
    
    if (submissionError || !submission) {
      return res.status(404).json({ success: false, error: submissionError?.message || 'Submission not found' });
    }
    
    // Get user email
    let email = submission.email_user || submission.email;
    if (!email && (submission.user_id || userId)) {
      try {
        email = await emailService.getUserEmailById(supabase, submission.user_id || userId);
      } catch (emailError) {
        return res.status(500).json({ success: false, error: emailError.message });
      }
    }
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'User email not found' });
    }
    
    const { data, error } = await emailService.sendVerificationStartedEmail(email, submission);
    
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error sending verification started email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Submission completed/approved
app.post('/api/submissions/completed', async (req, res) => {
  try {
    const { userId, submissionId } = req.body;
    
    // Get submission data
    const { data: submission, error: submissionError } = await supabase
      .from('product_submissions')
      .select('*')
      .eq('id', submissionId)
      .single();
    
    if (submissionError || !submission) {
      return res.status(404).json({ success: false, error: submissionError?.message || 'Submission not found' });
    }
    
    // Get user email
    let email = submission.email_user || submission.email;
    if (!email && (submission.user_id || userId)) {
      try {
        email = await emailService.getUserEmailById(supabase, submission.user_id || userId);
      } catch (emailError) {
        return res.status(500).json({ success: false, error: emailError.message });
      }
    }
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'User email not found' });
    }
    
    const { data, error } = await emailService.sendSubmissionCompletedEmail(email, submission);
    
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error sending submission completed email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Request feedback
app.post('/api/submissions/request-feedback', async (req, res) => {
  try {
    const { userId, submissionId } = req.body;
    
    // Get submission data
    const { data: submission, error: submissionError } = await supabase
      .from('product_submissions')
      .select('*')
      .eq('id', submissionId)
      .single();
    
    if (submissionError || !submission) {
      return res.status(404).json({ success: false, error: submissionError?.message || 'Submission not found' });
    }
    
    // Get user email
    let email = submission.email_user || submission.email;
    if (!email && (submission.user_id || userId)) {
      try {
        email = await emailService.getUserEmailById(supabase, submission.user_id || userId);
      } catch (emailError) {
        return res.status(500).json({ success: false, error: emailError.message });
      }
    }
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'User email not found' });
    }
    
    const { data, error } = await emailService.sendFeedbackRequestEmail(email, submission);
    
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error sending feedback request email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 