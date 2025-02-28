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
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');

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

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

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

// Updated website scraping function using Puppeteer
async function scrapeWebsiteWithPuppeteer(url) {
  let browser = null;
  try {
    // Launch browser with stealth mode
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // Add extra headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    });

    // Navigate to the page and wait for network to be idle
    await page.goto(url, {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: 30000
    });

    // Wait for the main content to load
    await page.waitForSelector('body', { timeout: 10000 });

    // Extract content
    const content = await page.evaluate(() => {
      const getMetaContent = (name) => {
        const meta = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return meta ? meta.getAttribute('content') : '';
      };

      // Get all text content while excluding script and style tags
      const getText = (selector) => {
        const elements = document.querySelectorAll(selector);
        return Array.from(elements)
          .map(el => el.textContent.trim())
          .filter(text => text.length > 0);
      };

      return {
        title: document.title,
        metaDescription: getMetaContent('description') || getMetaContent('og:description'),
        mainContent: document.body.innerText,
        headings: [
          ...getText('h1'),
          ...getText('h2'),
          ...getText('h3')
        ],
        paragraphs: getText('p'),
        links: Array.from(document.querySelectorAll('a'))
          .map(a => ({
            href: a.href,
            text: a.textContent.trim()
          }))
          .filter(link => link.text && link.href && !link.href.startsWith('#'))
      };
    });

    return content;
  } catch (error) {
    console.error('Puppeteer scraping error:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Update the scrape endpoint to use Puppeteer
app.post('/api/scrape-website', async (req, res) => {
  const { websiteUrl, websiteName, userId } = req.body;
  
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
    
    console.log('Attempting to scrape:', url);
    
    // Use Puppeteer to scrape the website
    const content = await scrapeWebsiteWithPuppeteer(url);
    
    console.log('Content extracted, analyzing with GPT...');
    
    // Use GPT to analyze the content
    const gptAnalysis = await analyzeWebsiteWithGPT(content, websiteName);
    
    console.log('GPT analysis complete');

    // Store the results in the database if userId is provided
    if (userId) {
      const { data, error } = await supabase
        .from('website_content')
        .insert([{
          user_id: userId,
          website_name: websiteName,
          website_url: url,
          content: content,
          gpt_analysis: gptAnalysis,
          relevant_directories: gptAnalysis?.suggestedDirectories?.length || 0
        }]);

      if (error) {
        console.error('Error storing website content:', error);
      }
    }
    
    // Return the scraped content and GPT analysis
    res.json({ 
      content,
      gptAnalysis,
      message: 'Website successfully analyzed'
    });
  } catch (error) {
    console.error('Error details:', error);
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
      from: 'BacklinkBot <noreply@backlinkbotai.com>',
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
      from: 'BacklinkBot <noreply@backlinkbotai.com>',
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

// Email templates for different status notifications
const EMAIL_TEMPLATES = {
  verifying: {
    subject: 'Your Product Submission is Being Verified',
    html: (productName) => `
      <h1>Your Product Submission is Being Verified</h1>
      <p>Hello,</p>
      <p>We wanted to let you know that your product submission "${productName}" is currently being verified by our team.</p>
      <p>We'll review all the details you've provided and get back to you soon with the next steps.</p>
      <p>Thank you for your patience!</p>
      <p>Best regards,<br>The BacklinkBot Team</p>
    `
  },
  'in progress': {
    subject: 'Your Product Submission is In Progress',
    html: (productName) => `
      <h1>Your Product Submission is In Progress</h1>
      <p>Hello,</p>
      <p>We're currently processing your product submission "${productName}".</p>
      <p>Our team is working on reviewing and preparing your submission. We'll keep you updated on any developments.</p>
      <p>Thank you for your patience!</p>
      <p>Best regards,<br>The BacklinkBot Team</p>
    `
  },
  done: {
    subject: 'Your Product Submission Process is Complete',
    html: (productName) => `
      <h1>Product Submission Process Complete</h1>
      <p>Hello,</p>
      <p>We've completed processing your product submission "${productName}".</p>
      <p>You can now view the final status and details in your dashboard.</p>
      <p>Thank you for working with us!</p>
      <p>Best regards,<br>The BacklinkBot Team</p>
    `
  },
  feedback1: {
    subject: 'Feedback Required for Your Product Submission',
    html: (productName) => `
      <h1>Feedback Required for Your Product Submission</h1>
      <p>Hello,</p>
      <p>We've reviewed your product submission "${productName}" and need some additional information or clarification.</p>
      <p>Please check your dashboard for specific feedback points that need to be addressed.</p>
      <p>Thank you for your cooperation!</p>
      <p>Best regards,<br>The BacklinkBot Team</p>
    `
  },
  pending: {
    subject: 'Product Submission Pending Review',
    html: (productName) => `
      <h1>Your Product Submission is Pending Review</h1>
      <p>Hello,</p>
      <p>Your product submission "${productName}" is currently pending review by our team.</p>
      <p>We'll begin the review process shortly and notify you of any updates.</p>
      <p>Thank you for your patience!</p>
      <p>Best regards,<br>The BacklinkBot Team</p>
    `
  },
  approved: {
    subject: 'Congratulations! Your Product Has Been Approved',
    html: (productName) => `
      <h1>Your Product Has Been Approved! 🎉</h1>
      <p>Hello,</p>
      <p>Great news! Your product "${productName}" has been approved and is now live on our platform.</p>
      <p>Thank you for choosing to list your product with us.</p>
      <p>Best regards,<br>The BacklinkBot Team</p>
    `
  },
  rejected: {
    subject: 'Update on Your Product Submission',
    html: (productName) => `
      <h1>Update on Your Product Submission</h1>
      <p>Hello,</p>
      <p>We've carefully reviewed your product submission "${productName}" and regret to inform you that we cannot approve it at this time.</p>
      <p>If you'd like to understand more about this decision or submit a revised application, please reach out to our support team.</p>
      <p>Best regards,<br>The BacklinkBot Team</p>
    `
  }
};

// Endpoint to handle product submission status changes
app.post('/api/product-submissions/status', async (req, res) => {
  const { submissionId, newStatus } = req.body;
  
  if (!submissionId || !newStatus) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      details: 'Both submissionId and newStatus are required'
    });
  }

  try {
    console.log(`Processing status update for submission ${submissionId} to ${newStatus}`);
    
    // Get the product submission details
    const { data: submission, error: fetchError } = await supabase
      .from('product_submissions')
      .select('*')
      .eq('id', submissionId)
      .single();

    if (fetchError) {
      console.error('Error fetching submission:', fetchError);
      throw fetchError;
    }
    
    if (!submission) {
      console.error('Submission not found:', submissionId);
      return res.status(404).json({ error: 'Product submission not found' });
    }

    console.log('Fetched submission:', {
      id: submission.id,
      product_name: submission.product_name,
      email_user: submission.email_user,
      status: submission.status
    });

    // Update the status
    const { error: updateError } = await supabase
      .from('product_submissions')
      .update({ status: newStatus })
      .eq('id', submissionId);

    if (updateError) {
      console.error('Error updating status:', updateError);
      throw updateError;
    }

    console.log('Status updated successfully');

    // Send email notification if template exists for the status
    if (EMAIL_TEMPLATES[newStatus]) {
      if (!submission.email_user) {
        console.warn('No email_user found for submission:', submissionId);
      } else {
        try {
          console.log('Attempting to send email to:', submission.email_user);
          
          const emailData = {
            from: 'BacklinkBot <noreply@backlinkbotai.com>',
            to: submission.email_user,
            subject: EMAIL_TEMPLATES[newStatus].subject,
            html: EMAIL_TEMPLATES[newStatus].html(submission.product_name)
          };
          
          console.log('Sending email with data:', emailData);
          
          const emailResponse = await resend.emails.send(emailData);
          console.log('Email sent successfully:', emailResponse);
          
        } catch (emailError) {
          console.error('Failed to send email:', {
            error: emailError,
            errorMessage: emailError.message,
            errorDetails: emailError.details
          });
          // Don't throw error here, just log it
        }
      }
    } else {
      console.log('No email template found for status:', newStatus);
    }

    res.json({ 
      message: 'Status updated successfully',
      submission: { ...submission, status: newStatus }
    });
  } catch (error) {
    console.error('Error in status update endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to update status',
      details: error.message
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 