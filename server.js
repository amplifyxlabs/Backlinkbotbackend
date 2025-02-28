const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const Airtable = require('airtable');
const cron = require('node-cron');
const { Resend } = require('resend');

// Load environment variables
dotenv.config();

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

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

// Add email sending endpoints
app.post('/api/send-submission-email', async (req, res) => {
  const { email, productName } = req.body;

  try {
    const { data, error } = await resend.emails.send({
      from: 'BacklinkBot <onboarding@resend.dev>',
      to: email,
      subject: 'Your Website Submission Received',
      html: `
        <h1>Thank you for submitting ${productName}!</h1>
        <p>We have received your website submission and will begin processing it shortly.</p>
        <p>You will receive another email once your submission is ready for directory listings.</p>
        <br>
        <p>Best regards,</p>
        <p>The BacklinkBot Team</p>
      `,
    });

    if (error) {
      console.error('Email error:', error);
      return res.status(400).json({ error });
    }

    res.status(200).json({ data });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.post('/api/send-credit-used-email', async (req, res) => {
  const { email, productName, plan } = req.body;

  try {
    const { data, error } = await resend.emails.send({
      from: 'BacklinkBot <onboarding@resend.dev>',
      to: email,
      subject: 'Directory Submission Process Started',
      html: `
        <h1>Directory Submission Process Started for ${productName}</h1>
        <p>We've started the directory submission process for your website using your ${plan} credit.</p>
        <p>Here's what happens next:</p>
        <ul>
          <li>Our system will begin submitting your website to relevant directories</li>
          <li>You'll receive progress updates as submissions are completed</li>
          <li>A final report will be sent once all submissions are done</li>
        </ul>
        <br>
        <p>Best regards,</p>
        <p>The BacklinkBot Team</p>
      `,
    });

    if (error) {
      console.error('Email error:', error);
      return res.status(400).json({ error });
    }

    res.status(200).json({ data });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 