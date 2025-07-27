import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField
} from 'discord.js';
import dotenv from 'dotenv';
import express from 'express';

// Load environment variables
dotenv.config();

// Validate Discord token
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Error: DISCORD_TOKEN is not set in the environment variables');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel, Partials.GuildMember],
});

// Data storage
const inviteCounts = new Map(); // Tracks invite counts per user per guild
const userInviter = new Map(); // Maps invited members to their inviters
const invitesCache = new Map(); // Caches invite usage counts

// Disboard configuration
const DISBOARD_BOT_ID = '302050872383242240'; // Disboard bot ID
const BUMP_CHANNEL_ID = '1392757104405909515'; // Channel ID for sending /bump
const BUMP_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  // Register slash commands
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  
  try {
    console.log('Started refreshing application (/) commands.');
    console.log('Commands to register:', commands.map(cmd => cmd.name));

    // Register commands globally
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    
    console.log('Successfully reloaded global application (/) commands.');

    // Optionally register commands for a specific guild for faster updates
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(client.user.id, guildId),
          { body: commands },
        );
        console.log(`Successfully reloaded guild-specific commands for guild ${guildId}.`);
      } catch (guildError) {
        console.error(`Error registering guild-specific commands for guild ${guildId}:`, guildError.message, guildError.stack);
      }
    }
  } catch (error) {
    console.error('Error registering global slash commands:', error.message, error.stack);
  }
  
  // Cache existing invites and initialize counts
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      console.log(`Fetched ${invites.size} existing invites for ${guild.name}`);
      
      // Store invite usage counts in cache
      invitesCache.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses || 0])));
      
      // Initialize invite counts from existing invites
      invites.forEach(invite => {
        if (invite.inviterId && invite.uses > 0) {
          const inviterId = invite.inviterId;
          const guildKey = `${guild.id}-${inviterId}`;
          const currentCount = inviteCounts.get(guildKey) || 0;
          inviteCounts.set(guildKey, currentCount + invite.uses);
          console.log(`Initialized ${invite.uses} invites for user ID ${inviterId} in ${guild.name}`);
        } else {
          console.log(`Skipped invite ${invite.code} in ${guild.name}: no inviter or no uses (uses: ${invite.uses})`);
        }
      });
    } catch (error) {
      console.error(`Could not fetch invites for ${guild.name}:`, error.message, error.stack);
    }
  }

  // Set up automatic /bump command for Disboard
  try {
    const bumpChannel = await client.channels.fetch(BUMP_CHANNEL_ID);
    if (!bumpChannel || !bumpChannel.isTextBased()) {
      console.error(`❌ Error: Channel ${BUMP_CHANNEL_ID} not found or not a text channel`);
      return;
    }

    const guild = bumpChannel.guild;
    // Check if Disboard is in the guild
    const disboardMember = await guild.members.fetch(DISBOARD_BOT_ID).catch(() => null);
    if (!disboardMember) {
      console.error(`❌ Error: Disboard bot (${DISBOARD_BOT_ID}) not found in guild ${guild.name}`);
      return;
    }

    const sendBumpCommand = async () => {
      try {
        // Check bot permissions in the channel
        const botMember = guild.members.me;
        const permissions = bumpChannel.permissionsFor(botMember);
        if (!permissions.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.UseApplicationCommands])) {
          console.error(`❌ Error: Missing permissions in channel ${BUMP_CHANNEL_ID}: SendMessages=${permissions.has(PermissionsBitField.Flags.SendMessages)}, UseApplicationCommands=${permissions.has(PermissionsBitField.Flags.UseApplicationCommands)}`);
          return;
        }

        // Fetch guild commands to find Disboard's /bump
        let commands = await guild.commands.fetch();
        console.log(`Fetched ${commands.size} guild commands for ${guild.name}:`, 
          commands.map(cmd => `${cmd.name} (app: ${cmd.applicationId})`));

        let bumpCommand = commands.find(cmd => cmd.name === 'bump' && cmd.applicationId === DISBOARD_BOT_ID);
        
        // If /bump not found in guild commands, try global commands
        if (!bumpCommand) {
          console.log(`Trying to fetch global commands for Disboard (${DISBOARD_BOT_ID})`);
          const globalCommands = await rest.get(Routes.applicationCommands(DISBOARD_BOT_ID)).catch(err => {
            console.error(`Failed to fetch global commands for Disboard:`, err.message);
            return [];
          });
          bumpCommand = globalCommands.find(cmd => cmd.name === 'bump');
          console.log(`Fetched ${globalCommands.length} global commands for Disboard:`, 
            globalCommands.map(cmd => cmd.name));
        }

        if (!bumpCommand) {
          console.error(`❌ Error: /bump command not found for Disboard in guild ${guild.name}`);
          return;
        }

        // Send the /bump command via REST
        await rest.post(Routes.interaction(guild.id), {
          body: {
            type: 2, // Application Command
            application_id: DISBOARD_BOT_ID,
            channel_id: BUMP_CHANNEL_ID,
            guild_id: guild.id,
            data: {
              id: bumpCommand.id,
              name: 'bump',
              type: 1 // Slash command
            },
            nonce: Date.now().toString(),
            session_id: client.sessionId
          }
        });
        console.log(`✅ Successfully sent /bump in channel ${BUMP_CHANNEL_ID} for guild ${guild.name}`);
      } catch (error) {
        console.error(`❌ Error sending /bump in channel ${BUMP_CHANNEL_ID}:`, error.message, error.stack);
      }
    };

    // Send /bump immediately and then every 2 hours
    await sendBumpCommand();
    setInterval(sendBumpCommand, BUMP_INTERVAL);
    console.log(`🕒 Automatic /bump scheduled every ${BUMP_INTERVAL / 1000 / 60} minutes in channel ${BUMP_CHANNEL_ID}`);
  } catch (error) {
    console.error(`❌ Error setting up automatic /bump for channel ${BUMP_CHANNEL_ID}:`, error.message, error.stack);
  }
});

// Track new members to update invite counts
client.on('guildMemberAdd', async (member) => {
  try {
    const guildId = member.guild.id;
    const cachedInvites = invitesCache.get(guildId) || new Map();
    const newInvites = await member.guild.invites.fetch();
    
    // Update cache with new invite usages
    const updatedInvites = new Map(newInvites.map(inv => [inv.code, inv.uses]));
    invitesCache.set(guildId, updatedInvites);

    // Find the used invite
    let usedInvite = null;
    for (const [code, uses] of updatedInvites) {
      const cachedUses = cachedInvites.get(code) || 0;
      if (uses > cachedUses) {
        usedInvite = newInvites.find(inv => inv.code === code);
        break;
      }
    }

    if (usedInvite && usedInvite.inviter) {
      const inviterId = usedInvite.inviter.id;
      const guildKey = `${guildId}-${inviterId}`;
      const count = inviteCounts.get(guildKey) || 0;
      inviteCounts.set(guildKey, count + 1);
      userInviter.set(member.id, inviterId);
      
      console.log(`[guildMemberAdd] ${member.user.tag} joined via invite from ${usedInvite.inviter.tag} (code: ${usedInvite.code}, uses: ${usedInvite.uses})`);
    } else {
      console.log(`[guildMemberAdd] Could not determine invite used by ${member.user.tag}`);
    }
  } catch (err) {
    console.error('Error in guildMemberAdd:', err.message, err.stack);
  }
});

// Handle member leaving without decrementing invite counts
client.on('guildMemberRemove', async (member) => {
  try {
    const inviterId = userInviter.get(member.id);
    if (inviterId) {
      console.log(`[guildMemberRemove] ${member.user.tag} left, invite count for ${inviterId} remains unchanged.`);
    }
  } catch (err) {
    console.error('Error in guildMemberRemove:', err.message, err.stack);
  }
});

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Check your current invite count'),
  new SlashCommandBuilder()
    .setName('checkinvites')
    .setDescription('Check the invite count of a user by their User ID')
    .addStringOption(option =>
      option.setName('user_id')
        .setDescription('The User ID of the member to check')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('resetinvites')
    .setDescription('Reset all invite counts (Admin only)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('forcebump')
    .setDescription('Manually trigger Disboard /bump (Admin only)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
];

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, user } = interaction;

  try {
    switch (commandName) {
      case 'invite':
        await handleInviteCommand(interaction);
        break;
      case 'checkinvites':
        await handleCheckInvitesCommand(interaction);
        break;
      case 'resetinvites':
        await handleResetCommand(interaction);
        break;
      case 'forcebump':
        await handleForceBumpCommand(interaction);
        break;
    }
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error.message, error.stack);
    
    const errorMessage = {
      content: '❌ An error occurred while processing your command.',
      ephemeral: true
    };
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage);
    } else {
      await interaction.reply(errorMessage);
    }
  }
});

async function handleInviteCommand(interaction) {
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  let totalInvites = 0;

  // Sum all invite counts for the user in this guild
  for (const [key, count] of inviteCounts) {
    if (key.startsWith(`${guildId}-${userId}`)) {
      totalInvites += count;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x00ff99)
    .setTitle('📨 Your Invite Count')
    .setDescription(`You have **${totalInvites}** successful invite${totalInvites !== 1 ? 's' : ''} on this server!`)
    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
    .setFooter({ 
      text: 'Keep inviting friends to grow the community!',
      iconURL: interaction.guild.iconURL({ dynamic: true })
    })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });

  // Auto-delete after 5 minutes (300 seconds)
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (error) {
      // Reply might already be deleted or expired
    }
  }, 300000);
}

async function handleCheckInvitesCommand(interaction) {
  const targetUserId = interaction.options.getString('user_id');
  const guildId = interaction.guildId;
  let totalInvites = 0;

  // Validate User ID format (basic check for Discord ID)
  if (!/^\d{17,19}$/.test(targetUserId)) {
    const embed = new EmbedBuilder()
      .setColor(0xff6b6b)
      .setTitle('❌ Invalid User ID')
      .setDescription('Please provide a valid Discord User ID (17-19 digits).')
      .setTimestamp();
    
    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
    
    // Auto-delete after 5 minutes
    setTimeout(async () => {
      try {
        await interaction.deleteReply();
      } catch (error) {
        // Reply might already be deleted or expired
      }
    }, 300000);
    
    return;
  }

  // Sum all invite counts for the target user in this guild
  for (const [key, count] of inviteCounts) {
    if (key.startsWith(`${guildId}-${targetUserId}`)) {
      totalInvites += count;
    }
  }

  // Try to fetch the user to get their tag and avatar
  let targetUser;
  try {
    targetUser = await client.users.fetch(targetUserId);
  } catch (error) {
    console.error(`Error fetching user ${targetUserId}:`, error.message);
  }

  const embed = new EmbedBuilder()
    .setColor(0x00ff99)
    .setTitle(`📨 Invite Count for ${targetUser ? targetUser.tag : `User ID ${targetUserId}`}`)
    .setDescription(`${targetUser ? `**${targetUser.tag}** has` : `User ID **${targetUserId}** has`} **${totalInvites}** successful invite${totalInvites !== 1 ? 's' : ''} on this server!`)
    .setThumbnail(targetUser ? targetUser.displayAvatarURL({ dynamic: true }) : null)
    .setFooter({ 
      text: 'Invite tracking by InviteBot',
      iconURL: interaction.guild.iconURL({ dynamic: true })
    })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });

  // Auto-delete after 5 minutes (300 seconds)
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (error) {
      // Reply might already be deleted or expired
    }
  }, 300000);
}

async function handleResetCommand(interaction) {
  // Check for administrator permissions
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({
      content: '❌ You need Administrator permissions to reset invite counts.',
      ephemeral: true
    });
    return;
  }

  const guildId = interaction.guildId;
  
  // Remove all invite counts for this guild
  const keysToDelete = [];
  for (const key of inviteCounts.keys()) {
    if (key.startsWith(`${guildId}-`)) {
      keysToDelete.push(key);
    }
  }
  
  keysToDelete.forEach(key => inviteCounts.delete(key));
  
  // Clear user inviter mappings for this guild's members
  const membersToRemove = [];
  for (const [memberId, inviterId] of userInviter.entries()) {
    const member = await interaction.guild.members.fetch(memberId).catch(() => null);
    if (member) {
      membersToRemove.push(memberId);
    }
  }
  
  membersToRemove.forEach(memberId => userInviter.delete(memberId));

  const embed = new EmbedBuilder()
    .setColor(0xff6b6b)
    .setTitle('🔄 Invite Counts Reset')
    .setDescription(`All invite counts for **${interaction.guild.name}** have been reset to 0.`)
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ 
      text: `Reset by ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
  
  console.log(`Invite counts reset for guild ${interaction.guild.name} by ${interaction.user.tag}`);
}

async function handleForceBumpCommand(interaction) {
  // Check for administrator permissions
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({
      content: '❌ You need Administrator permissions to use this command.',
      ephemeral: true
    });
    return;
  }

  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    const guild = interaction.guild;
    const bumpChannel = await client.channels.fetch(BUMP_CHANNEL_ID);
    if (!bumpChannel || !bumpChannel.isTextBased()) {
      await interaction.reply({
        content: `❌ Error: Channel ${BUMP_CHANNEL_ID} not found or not a text channel`,
        ephemeral: true
      });
      return;
    }

    // Check bot permissions in the channel
    const botMember = guild.members.me;
    const permissions = bumpChannel.permissionsFor(botMember);
    if (!permissions.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.UseApplicationCommands])) {
      await interaction.reply({
        content: `❌ Error: Missing permissions in channel ${BUMP_CHANNEL_ID}: SendMessages=${permissions.has(PermissionsBitField.Flags.SendMessages)}, UseApplicationCommands=${permissions.has(PermissionsBitField.Flags.UseApplicationCommands)}`,
        ephemeral: true
      });
      return;
    }

    // Check if Disboard is in the guild
    const disboardMember = await guild.members.fetch(DISBOARD_BOT_ID).catch(() => null);
    if (!disboardMember) {
      await interaction.reply({
        content: `❌ Error: Disboard bot (${DISBOARD_BOT_ID}) not found in guild ${guild.name}`,
        ephemeral: true
      });
      return;
    }

    // Fetch guild commands to find Disboard's /bump
    let commands = await guild.commands.fetch();
    console.log(`[forcebump] Fetched ${commands.size} guild commands for ${guild.name}:`, 
      commands.map(cmd => `${cmd.name} (app: ${cmd.applicationId})`));

    let bumpCommand = commands.find(cmd => cmd.name === 'bump' && cmd.applicationId === DISBOARD_BOT_ID);
    
    // If /bump not found in guild commands, try global commands
    if (!bumpCommand) {
      console.log(`[forcebump] Trying to fetch global commands for Disboard (${DISBOARD_BOT_ID})`);
      const globalCommands = await rest.get(Routes.applicationCommands(DISBOARD_BOT_ID)).catch(err => {
        console.error(`[forcebump] Failed to fetch global commands for Disboard:`, err.message);
        return [];
      });
      bumpCommand = globalCommands.find(cmd => cmd.name === 'bump');
      console.log(`[forcebump] Fetched ${globalCommands.length} global commands for Disboard:`, 
        globalCommands.map(cmd => cmd.name));
    }

    if (!bumpCommand) {
      await interaction.reply({
        content: `❌ Error: /bump command not found for Disboard in guild ${guild.name}`,
        ephemeral: true
      });
      return;
    }

    // Send the /bump command via REST
    await rest.post(Routes.interaction(guild.id), {
      body: {
        type: 2, // Application Command
        application_id: DISBOARD_BOT_ID,
        channel_id: BUMP_CHANNEL_ID,
        guild_id: guild.id,
        data: {
          id: bumpCommand.id,
          name: 'bump',
          type: 1 // Slash command
        },
        nonce: Date.now().toString(),
        session_id: client.sessionId
      }
    });

    await interaction.reply({
      content: `✅ Successfully sent /bump in channel <#${BUMP_CHANNEL_ID}>`,
      ephemeral: true
    });
  } catch (error) {
    console.error(`[forcebump] Error sending /bump in channel ${BUMP_CHANNEL_ID}:`, error.message, error.stack);
    await interaction.reply({
      content: `❌ Error sending /bump: ${error.message}`,
      ephemeral: true
    });
  }
}

// Initialize Express server
const app = express();
const PORT = process.env.PORT || 3000;

// Add root route to handle GET /
app.get('/', (req, res) => {
  res.status(200).json({ message: 'Bot is alive' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Bot is running' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// Error handling
client.on('error', error => {
  console.error('Discord client error:', error.message, error.stack);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error.message, error.stack);
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('Failed to login to Discord:', error.message, error.stack);
  process.exit(1);
});
