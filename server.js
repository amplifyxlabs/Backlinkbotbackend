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
const puppeteer = require('puppeteer');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteerExtra = require('puppeteer-extra');
const chromium = require('@sparticuz/chromium');

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

// Add stealth plugin
puppeteerExtra.use(StealthPlugin());

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
    console.log('Launching browser...');
    
    // Configure chromium for Render environment with balanced settings
    const puppeteerConfig = {
      headless: 'new', // Use new headless mode for better performance
      defaultViewport: {
        width: 1024, // Medium viewport for better content capture
        height: 768,
        deviceScaleFactor: 1,
      },
      executablePath: await chromium.executablePath(),
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-accelerated-2d-canvas',
        '--disable-web-security',
        '--disable-features=site-per-process',
        '--window-size=1024,768'
      ],
      ignoreHTTPSErrors: true
    };

    // Launch browser with puppeteer directly
    browser = await puppeteer.launch(puppeteerConfig);

    console.log('Browser launched successfully');
    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1024, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // Set reasonable timeouts
    await page.setDefaultNavigationTimeout(30000);
    
    // Block only heavy resources but allow CSS and basic JS for better content rendering
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media' || 
          resourceType === 'video' || resourceType === 'audio') {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log('Navigating to URL:', url);
    // Navigate with balanced wait conditions
    await page.goto(url, {
      waitUntil: 'domcontentloaded', // Wait for DOM content
      timeout: 30000 // 30 second timeout
    });

    // Wait a short time for any critical JS to execute
    await page.waitForTimeout(2000);

    console.log('Page loaded, extracting content...');
    
    // Extract balanced content
    const content = await page.evaluate(() => {
      // Get meta content
      const getMetaContent = (name) => {
        const meta = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return meta ? meta.getAttribute('content') : '';
      };

      // Get text content with reasonable limits
      const getText = (selector, limit = 10) => {
        const elements = document.querySelectorAll(selector);
        const results = [];
        for (let i = 0; i < Math.min(elements.length, limit); i++) {
          const text = elements[i].textContent.trim();
          if (text.length > 0) results.push(text);
        }
        return results;
      };

      // Get important links
      const getLinks = (limit = 30) => {
        const links = [];
        const elements = document.querySelectorAll('a');
        let count = 0;
        
        for (let i = 0; i < elements.length && count < limit; i++) {
          const a = elements[i];
          const href = a.href;
          const text = a.textContent.trim();
          
          if (href && text && text.length > 3 && !href.startsWith('#')) {
            links.push({ href, text });
            count++;
          }
        }
        
        return links;
      };

      // Get main content with reasonable length
      const getMainContent = () => {
        // Try to get content from main content areas first
        const mainElements = document.querySelectorAll('main, article, .content, #content, .main');
        if (mainElements.length > 0) {
          return Array.from(mainElements)
            .map(el => el.textContent.trim())
            .join(' ')
            .substring(0, 3000); // 3000 chars is reasonable
        }
        
        // Fallback to body text with limit
        return document.body.innerText.substring(0, 3000);
      };

      return {
        title: document.title,
        metaDescription: getMetaContent('description') || getMetaContent('og:description'),
        mainContent: getMainContent(),
        headings: [
          ...getText('h1', 5),
          ...getText('h2', 10),
          ...getText('h3', 10)
        ],
        paragraphs: getText('p', 15),
        links: getLinks(30)
      };
    });

    return content;
  } catch (error) {
    console.error('Puppeteer scraping error:', error);
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log('Browser closed successfully');
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
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
  
  // Set a timeout for the entire operation - increased to 90 seconds
  const TIMEOUT_MS = 90000; // 90 seconds
  let timeoutId;
  
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Operation timed out after 90 seconds'));
    }, TIMEOUT_MS);
  });
  
  try {
    // Normalize URL
    let url = websiteUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    console.log('Attempting to scrape:', url);
    
    // Race between the scraping operation and the timeout
    const content = await Promise.race([
      scrapeWebsiteWithPuppeteer(url),
      timeoutPromise
    ]);
    
    // Clear the timeout if scraping completed successfully
    clearTimeout(timeoutId);
    
    console.log('Content extracted, analyzing with GPT...');
    
    // Use GPT to analyze the content
    const gptAnalysis = await analyzeWebsiteWithGPT(content, websiteName);
    
    console.log('GPT analysis complete');

    // Store the results in the database if userId is provided
    if (userId) {
      try {
        const { error } = await supabase
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
      } catch (dbError) {
        console.error('Database error:', dbError);
        // Continue even if database storage fails
      }
    }
    
    // Return the scraped content and GPT analysis
    res.json({ 
      content,
      gptAnalysis,
      message: 'Website successfully analyzed'
    });
  } catch (error) {
    // Clear the timeout if there was an error
    clearTimeout(timeoutId);
    
    console.error('Error details:', error);
    
    // Return a more user-friendly error message
    if (error.message.includes('timed out')) {
      res.status(504).json({
        error: 'Scraping timed out',
        message: 'The website took too long to respond. Please try again later or try a different URL.',
        details: error.message
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to scrape website',
        message: error.message,
        details: error.response?.data || 'No additional details available'
      });
    }
  }
});

// Function to analyze website content with GPT
async function analyzeWebsiteWithGPT(content, websiteName) {
  try {
    // Create a more structured content summary with all available information
    const contentSummary = `
      Website Name: ${websiteName || 'Unknown'}
      Website Title: ${content.title || 'No title found'}
      Meta Description: ${content.metaDescription || 'No meta description found'}
      
      Main Headings:
      ${content.headings.slice(0, 5).join('\n') || 'No headings found'}
      
      Content Sample:
      ${content.paragraphs.slice(0, 3).join('\n') || 'No paragraphs found'}
      
      Key Links:
      ${content.links.slice(0, 5).map(l => `${l.text} (${l.href})`).join('\n') || 'No links found'}
      
      Main Content Excerpt:
      ${content.mainContent?.substring(0, 500) || 'No main content found'}
    `;
    
    const prompt = `
      You are analyzing a website to create directory listings that will drive traffic and increase visibility.
      
      Website Information:
      ${contentSummary}
      
      Based on this information, provide:
      
      1. Description: Write a compelling 2-3 sentence description that clearly explains what the website offers, its value proposition, and target audience. Make it persuasive and SEO-friendly.
      
      2. Categories: Identify exactly 3 specific, relevant categories that best represent this website for directory listings. Choose from common directory categories like: Business, Technology, Health, Education, Finance, E-commerce, Marketing, AI/ML, SaaS, Productivity, Entertainment, Social Media, etc.
      
      3. Features: List 3 specific, standout features or benefits that would attract users to this website. Be concrete and specific, not generic.
      
      Format your response as clean JSON:
      {
        "description": "Your compelling description here.",
        "categories": ["Primary Category", "Secondary Category", "Tertiary Category"],
        "features": ["Specific Feature 1", "Specific Feature 2", "Specific Feature 3"]
      }
    `;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Using gpt-4o-mini for better quality
      messages: [
        { 
          role: "system", 
          content: "You are an expert SEO and directory listing specialist. Your task is to analyze websites and create compelling, accurate directory listings that will drive traffic and increase visibility. Focus on being specific, accurate, and persuasive."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.5, // Slightly higher temperature for more creative descriptions
      max_tokens: 500 // Allow more tokens for better quality
    });
    
    const analysis = JSON.parse(response.choices[0].message.content);
    
    // Ensure we have valid data in each field
    return {
      description: analysis.description || "A website offering digital services and solutions.",
      categories: Array.isArray(analysis.categories) && analysis.categories.length > 0 
        ? analysis.categories.slice(0, 3) 
        : ["Technology", "Business", "Internet"],
      features: Array.isArray(analysis.features) && analysis.features.length > 0 
        ? analysis.features.slice(0, 3) 
        : ["User-friendly interface", "Digital solutions", "Online services"],
      analysisDate: new Date().toISOString(),
      suggestedDirectories: 467 // Adding a fixed number for relevant directories
    };
  } catch (error) {
    console.error('Error analyzing with GPT:', error);
    // Return fallback data if analysis fails
    return {
      description: `${websiteName || 'This website'} provides digital services and solutions for online users.`,
      categories: ["Technology", "Internet", "Business"],
      features: ["User-friendly interface", "Digital solutions", "Online services"],
      analysisDate: new Date().toISOString(),
      suggestedDirectories: 467
    };
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