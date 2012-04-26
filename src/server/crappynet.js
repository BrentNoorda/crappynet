/*jslint white:false plusplus:false browser:true nomen:false */
/*globals require, console, process, __dirname */
var VERSION = '0.003';
/*
    CrappyNet - Simulate a crappy network.

    CrappyNet is a development and QA tool for helping teams create products that work well in the
    real world (not just the idealized world simulated in a programmer's development environment).

    This script runs as a server gateway on the node.js framework.

    To learn more about CrappyNet, read:

        http://www.problemssolvingproblems.com/home/crappynet

*/

// The following are specified with input parameters
var ADMIN_PORT;
var GATEWAY_PORT;
var PREFERENCES_FILESPEC;
var LOG_LEVEL = 3;   // minimum level to display log stuff (0 = high, 1 = log)
var RECENT_URL_LISTCOUNT = 5;    // how many urls to keep in recent lists

// cfg - all configuration parameters are defined here - these are the defaults if no file PREFERENCES_FILESPEC exists
var gCFG = {
    host: { value: 'google.com', type: 'text' },
    port: { value: 80, type:'int' },

    // parameters for how crappy to perform
    download_mbps_min: { value: 1.1, type: 'float' },
    download_mbps_max: { value: 2.1, type: 'float' },
    upload_mbps_min: { value: 0.25, type: 'float' },
    upload_mbps_max: { value: 0.75, type: 'float' },

    download_firstbyte_min: { value: 100, type:'int' },
    download_firstbyte_max: { value: 500, type:'int' },
    upload_firstbyte_min: { value: 300, type:'int' },
    upload_firstbyte_max: { value: 900, type:'int' },

    req_dropped: { value: 10, type:'int' },
    resp_dropped: { value: 10, type:'int' },

    req_partial: { value: 10, type:'int' },
    resp_partial: { value: 10, type:'int' },

    coma_frequency: { value: 0 /*2*60*/, type:'int' },
    coma_length: { value: 30, type:'int' },

    max_requests: { value: 5, type:'int' }
};

var gStats = {
    good_transactions : 0, // how many connections have finished
    recent_good_transactions : [], // a list of a few recently-dropped requests
    dropped_requests : 0, // how many of those connections were simply dropped requests
    recent_dropped_requests : [], // a list of a few recently-dropped requests
    dropped_responses : 0, // how many of those connections were simply dropped requests
    recent_dropped_responses : [], // a list of a few recently-dropped requests
    partial_requests : 0, // how many of those connections did not send all of the data up
    recent_partial_requests : [], // a list of a few recently-dropped requests
    partial_responses : 0, // how many of those connections did not send all of the data up
    recent_partial_responses : [], // a list of a few recently-dropped requests
    unhandled_errors : 0,
    recent_unhandled_errors : [ ],
    connections : [ ]   // will add to this with the following data:
                        //  .time = new Date() when the connection started
                        //  .url
                        //  .method
                        //  .upload_mbps
                        //  .upload_sending = how many bytes remaining to send
                        //  .upload_sent = how many bytes have been sent (approx)
                        //  .upload_header_length = length of the upload header
                        //  .upload_content_length = content length from content-length header (or null if not found)
                        //  .download_mbps
                        //  .download_sending = how many bytes remaining to send
                        //  .download_sent = how many bytes have been sent (approx)
                        //  .download_header_length = length of the download header
                        //  .download_content_length = content length from content-length header (or null if not found)
};
var gGatewayServer = null;
var gComaTimeout = null;
var gEndComaTimeout = null;
var gAbortActions = [ ]; // if something is running that could be aborted, add it to this list

var http = require('http');
var url = require('url');
var fs = require('fs');
var qs = require('querystring');
var path = require('path');
var util = require('util');
var assert = require('assert');

function log(log_level,msg)
{
    if ( log_level <= LOG_LEVEL )
    {
        console.log(msg);
    }
}


function admin_request_handler(req,res)  // called on each request from client
{
    var body, url_parse;

    function send_file(filename,content_type)
    {
        req.on('end', function() {
            fs.readFile(path.normalize(__dirname + '/../client/' + filename), function (err,data) {
                res.writeHead(200, {'Content-type': content_type});
                res.write(data);
                res.end();
            });
        });
    }

    function send_admin_console() {
        var prop;
        function floatstr(n)   // emphasize it's a float by making sure some decimal characters appear
        {
            var ret = String(n);
            if ( -1 === ret.indexOf('.') )
            {
                ret += '.0';
            }
            return ret;
        }

        log(1,"howdy 3");

        log(1,'gCFG:');
        for ( prop in gCFG )
        {
            if ( gCFG.hasOwnProperty(prop) )
            {
                log(1,'  ' + prop + ': ' + gCFG[prop].value);
            }
        }
        res.writeHead(200, {'Content-type': 'text/html'});

        fs.readFile(__dirname + '/../client/admin_console.html', function (err,data) {
            var prop, html = data.toString();
            for ( prop in gCFG )
            {
                if ( gCFG.hasOwnProperty(prop) )
                {
                    html = html.replace('$$$'+prop+'$$$',(gCFG[prop].type==='float' ? floatstr(gCFG[prop].value) : gCFG[prop].value));
                }
            }
            res.end(html);
        });
    }

    if (req.method === 'POST') {
        body = '';
        log(1,"data has been posted");
        req.on('data', function(data){
            body += data;
        });
        req.on('end', function () {
            var newCFG, copprop, newValue, parsed_body = body.replace(/\r\n/gi, "&");
            newCFG = qs.parse(parsed_body);

            // clean up some fields of newCFG that we don't want or should not be strings
            delete newCFG.submit;
            for ( copprop in gCFG )
            {
                if ( gCFG.hasOwnProperty(copprop) )
                {
                    try {
                        if ( gCFG[copprop].type === 'float' )
                        {
                            newValue = parseFloat(newCFG[copprop]);
                        }
                        else if ( gCFG[copprop].type === 'int' )
                        {
                            newValue = parseInt(newCFG[copprop],10);
                        }
                        else
                        {
                            newValue = newCFG[copprop];
                        }
                        gCFG[copprop].value = newValue;
                    } catch(e) {
                        // no big deal - leave the value as it is
                        log(0,"ERROR!!!!! parsing input value on property " + copprop);
                    }
                }
            }

            newCFG = { };
            for ( copprop in gCFG )
            {
                if ( gCFG.hasOwnProperty(copprop) )
                {
                    newCFG[copprop] = gCFG[copprop].value;
                }
            }
            fs.writeFile(PREFERENCES_FILESPEC, JSON.stringify(newCFG,null,4));
            send_admin_console();
        });
    } else {
        url_parse = url.parse(req.url,true,true);
        if (url_parse.query.source === 'stats')
        {
            req.on('end', function() {
                res.writeHead(200, {'Content-type': 'application/json'});
                res.write(JSON.stringify(gStats));
	            res.end();
	        });
        }
        else if (url_parse.query.source === 'jquery')
        {
            send_file('jquery-1.7.1.min.js','text/javascript');
        }
        else if (url_parse.query.source === 'admin_console_js')
        {
            send_file('admin_console.js','text/javascript');
        }
        else if (url_parse.query.source === 'admin_console_css')
        {
            send_file('admin_console.css','text/css');
        }
        else
        {
            req.on('end', function(){
                log(1,"howdy 2.5");
                send_admin_console();
            });
        }
    }

}

function random_chance(percent) // if random number (0 to 99) less than this then true, else false
{
    return ( percent === 0 ) ? false : ( Math.floor(Math.random()*100) < percent );
}

function gateway_request_handler(request,response)  // called on each request from client
{
    var uheaders, uheader, uh, options, proxy=null, state, connection, upload_bytes_per_10ms, download_bytes_per_10ms, upload_socket,
        partial_upload_header = false, discard_all_further_upload_data = false, partial_download_header = false, discard_all_further_download_data = false;

    // some requests are simply dropped at the beggining
    if ( random_chance(gCFG.req_dropped.value) )
    {
        log(1,"Dropped request for " + request.url);
        while ( RECENT_URL_LISTCOUNT <= gStats.recent_dropped_requests.length )
        {
            gStats.recent_dropped_requests.pop();
        }
        gStats.recent_dropped_requests.unshift(request.url);
        gStats.dropped_requests++;
        request.connection.destroy(); // destroy the underlying socket so no data goes out
        response.end();
        return;
    }

    function abort_this_connection()
    {
        log(0,"@@@@@@@@@@@ Connection " + connection.url + " aborted @@@@@@@@@@@");
        gAbortActions.splice(gAbortActions.indexOf(abort_this_connection),1);
    }

    function calculate_millisecond(bytecount,mbps)
    {
        var bitcount, ms_time;
        bitcount = bytecount * 8.0; // are there other bits that should be included (10?)
        ms_time = (bitcount / (1024.0 * 1024.0) ) / mbps;
        return Math.ceil(ms_time * 1000.0);
    }

    function bytes_per_10ms(mbps)   // approximately how many bytes can be sent in 10 milliseconds
    {
        return Math.ceil(( (mbps * 1024.0 * 1024.0) / 8.0) / 100.0);
    }

    // keep track of the state of this connection
    request.pause();
    state = {
        upload_chunks : [],       // when data is received it goes here, and then we'll send from these chunks max upload_bytes_per_10ms bytes at a time
        upload_timeout : null,    // set timeout before sending next data to match upload_mbps
        upload_end_received : false,  // have we received an end to what is being uploaded
        upload_paused : true,     // help with throttling upload by pausing it a lot

        download_chunks : [],       // when data is received it goes here, and then we'll send from these chunks max download_bytes_per_10ms bytes at a time
        download_timeout : null,    // set timeout before sending next data to match download_mbps
        download_end_received : false  // have we received an end to what is being downloaded
    };

    connection = {
        time : new Date(),
        url : request.url,
        method : request.method,
        upload_mbps : gCFG.upload_mbps_min.value + ( Math.random() * (gCFG.upload_mbps_max.value - gCFG.upload_mbps_min.value) ),
        upload_firstbyte : Math.round(gCFG.upload_firstbyte_min.value + ( Math.random() * (gCFG.upload_firstbyte_max.value - gCFG.upload_firstbyte_min.value) )),
        partial_this_request : random_chance(gCFG.req_partial.value),
        upload_sending : 0,
        upload_sent : 0,
        upload_header_length : null,
        upload_content_length : null,
        drop_this_response : random_chance(gCFG.resp_dropped.value), // if true, then let the server send all it's response, but then kill the client connection so it gets nothing
        download_mbps : gCFG.download_mbps_min.value + ( Math.random() * (gCFG.download_mbps_max.value - gCFG.download_mbps_min.value) ),
        download_firstbyte : Math.round(gCFG.download_firstbyte_min.value + ( Math.random() * (gCFG.download_firstbyte_max.value - gCFG.download_firstbyte_min.value) )),
        partial_this_response : random_chance(gCFG.resp_partial.value),
        download_sending : 0,
        download_sent : 0,
        download_header_length : null,
        download_content_length : null,
        terminated : false
    };
    if ( connection.drop_this_response )
    {
        connection.partial_this_response = false;  // don't do partial response if we're doing NO response
    }
    upload_socket = null;
    upload_bytes_per_10ms = bytes_per_10ms(connection.upload_mbps);
    download_bytes_per_10ms = bytes_per_10ms(connection.download_mbps);

    gStats.connections.push(connection);
    gAbortActions.push(abort_this_connection);

    function connection_terminated()
    {
        // this connection has been terminated, so return from the connections list very soon
        var idx;
        function remove_from_connections()
        {
            delete connection.terminated;
            gStats.connections.splice(gStats.connections.indexOf(connection),1);
        }
        connection.terminated = true;
        idx = gAbortActions.indexOf(abort_this_connection);
        if ( idx !== -1 )
        {
            gAbortActions.splice(idx,1);
        }
        setTimeout(remove_from_connections,10 * 1000);
    }

    function intercept_upload_storeHeader()
    {
        proxy._original_StoreHeader = proxy._storeHeader;
        proxy._storeHeader = function(firstLine, headers)
        {
            log(0,'upload WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW');
            log(0,"called _storeHeader");
            log(0,"firstLine = " + firstLine);
            log(0,"headers = " + headers);
            log(0,'proxy._header = ' + proxy._header);
            log(0,'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM');
            proxy._original_StoreHeader(firstLine,headers);
            log(0,'proxy._header.length = ' + proxy._header.length);
            log(0,'proxy._header = ' + proxy._header);
            connection.upload_header_length = proxy._header.length;
            if ( partial_upload_header !== false )
            {
                // force the header to be incomplete at some random place
                partial_upload_header = Math.floor(Math.random() * connection.upload_header_length);
                proxy._header = proxy._header.substring(0,partial_upload_header);
            }
        };
    }

    function intercept_download_storeHeader()
    {
        response._original_StoreHeader = response._storeHeader;
        response._storeHeader = function(firstLine, headers)
        {
            log(0,'download WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW');
            log(0,"called _storeHeader");
            log(0,"firstLine = " + firstLine);
            log(0,"headers = " + headers);
            log(0,'response._header = ' + response._header);
            log(0,'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM');
            response._original_StoreHeader(firstLine,headers);
            log(0,'response._header.length = ' + response._header.length);
            log(0,'response._header = ' + response._header);
            connection.download_header_length = response._header.length;
            if ( partial_download_header !== false )
            {
                // force the header to be incomplete at some random place
                partial_download_header = Math.floor(Math.random() * connection.download_header_length);
                response._header = response._header.substring(0,partial_download_header);
            }
        };
    }
    intercept_download_storeHeader();

    function maybe_all_done()
    {
        if ( (proxy === null) && (upload_socket !== null) && (response === null) )
        {
            var good_transaction = true;
            log(1,"################## ALL DONE ######################");
            if ( connection.drop_this_response )
            {
                good_transaction = false;
                gStats.dropped_responses++;
                while ( RECENT_URL_LISTCOUNT <= gStats.recent_dropped_responses.length )
                {
                    gStats.recent_dropped_responses.pop();
                }
                gStats.recent_dropped_responses.unshift(connection.url);
            }
            if ( discard_all_further_upload_data )
            {
                good_transaction = false;
                gStats.partial_requests++;
                while ( RECENT_URL_LISTCOUNT <= gStats.recent_partial_requests.length )
                {
                    gStats.recent_partial_requests.pop();
                }
                gStats.recent_partial_requests.unshift(connection.url);
            }
            if ( discard_all_further_download_data )
            {
                good_transaction = false;
                gStats.partial_responses++;
                while ( RECENT_URL_LISTCOUNT <= gStats.recent_partial_responses.length )
                {
                    gStats.recent_partial_responses.pop();
                }
                gStats.recent_partial_responses.unshift(connection.url);
            }

            if ( good_transaction )
            {
                gStats.good_transactions++;
                while ( RECENT_URL_LISTCOUNT <= gStats.recent_good_transactions.length )
                {
                    gStats.recent_good_transactions.pop();
                }
                gStats.recent_good_transactions.unshift(connection.url);
            }
            connection_terminated();
        }
    }

    function upload_next_chunk() // called on timeout when it's ok to send more
    {
        var chunk, send_length;
        state.upload_timeout = null;
        log(1,"-------------upload next chunk-------------");

        function proxy_endoflife()
        {
            state.upload_timeout = null;
            proxy = null;
            maybe_all_done();
        }

        if ( state.upload_chunks.length === 0 )
        {
            if ( state.upload_paused )
            {
                request.resume();
                state.upload_paused = false;
            }
            if ( state.upload_end_received )
            {
                if ( connection.upload_header_length === null )
                {
                    // end happened but no data was actually ever sent up, so no header went out (a nodejs thing) so finally send those bytes now
                    if ( connection.partial_this_request !== false )
                    {
                        // supposed to do a partial send on this one, but the only thing sent is the header, so partialize on the header
                        partial_upload_header = true;
                        discard_all_further_upload_data = true;
                    }
                    proxy.end();
                    log(0,"1 PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    if ( partial_upload_header !== false )
                    {
                        connection.upload_sent = connection.partial_this_request = partial_upload_header;
                    }
                    else
                    {
                        connection.upload_sent = connection.upload_header_length;
                    }
                    state.upload_timeout = setTimeout(proxy_endoflife,calculate_millisecond(connection.upload_sent,connection.upload_mbps));
                }
                else
                {
                    log(0,"2 PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
                    proxy.end();
                    proxy_endoflife();
                }
            }
        }
        else
        {
            chunk = state.upload_chunks.shift();

            if ( discard_all_further_upload_data )
            {
                state.upload_timeout = setTimeout(upload_next_chunk,0);
            }
            else
            {
                if ( connection.upload_header_length === null )
                {
                    // the first write is special in that the header will not have been put together until the first write happens (a nodejs quirk)
                    if ( connection.partial_this_request !== false )
                    {
                        // if want partial uploads, let's have that fall within the header 10% of the time
                        if ( random_chance(10) )
                        {
                            partial_upload_header = true;   // this will be handled when proxy.end() happens
                            discard_all_further_upload_data = true;
                            send_length = 0;
                        }
                        else
                        {
                            // determine where else to do the partial thing
                            if ( connection.upload_content_length !== null )
                            {
                                // set partial_this_request to where the upload should be
                                connection.partial_this_request = Math.floor(Math.random() * connection.upload_content_length);
                            }
                            else
                            {
                                // we don't know how long the content length is suppsed to be, so pick a small number
                                connection.partial_this_request = 13;
                            }
                            if ( connection.partial_this_request === 0 )
                            {
                                send_length = 0;
                                discard_all_further_upload_data = true;
                            }
                            else
                            {
                                if ( connection.partial_this_request <= chunk.length )
                                {
                                    chunk = chunk.slice(0,connection.partial_this_request);
                                    discard_all_further_upload_data = true;
                                }
                                proxy.write(chunk);
                                send_length = chunk.length + connection.upload_header_length;
                                connection.partial_this_request += connection.upload_header_length; // include the header in total request count
                            }
                        }
                    }

                }
                else
                {
                    if ( connection.partial_this_request !== false )
                    {
                        if ( connection.partial_this_request <= (connection.upload_sent + chunk.length) )
                        {
                            chunk = chunk.slice(0,connection.partial_this_request-connection.upload_sent);
                            discard_all_further_upload_data = true;
                        }
                    }
                    send_length = chunk.length;
                    proxy.write(chunk);
                }

                connection.upload_sent += send_length;
                connection.upload_sending -= send_length;
                state.upload_timeout = setTimeout(upload_next_chunk,calculate_millisecond(send_length,connection.upload_mbps));
            }
            if ( !state.upload_paused )
            {
                request.pause();
                state.upload_paused = true;
            }
        }
    }
    function new_upload_stuff_is_ready() // called when new stuff is ready to upload in case a timeout is not ready to upload soon
    {
        if ( (state.upload_timeout === null) && (proxy !== null) && (upload_socket !== null) )
        {
            state.upload_timeout = setTimeout(upload_next_chunk,0);
        }
    }

    //request.headers.host = gCFG.host.value;

    options = {
        host: gCFG.host.value,
        port: gCFG.port.value,
        path: request.url,
        method: request.method,
        headers: request.headers
    };

    // find the connection.upload_header_length if that header does indeed exist
    uheaders = Object.keys(request.headers);
    for ( uh = uheaders.length; uh--; )
    {
        uheader = uheaders[uh];
        if ( uheader.toLowerCase() === 'content-length' )
        {
            try {
                connection.upload_content_length = parseInt(request.headers[uheader],10);
            } catch(e) {
            }
        }
    }

    function close_prematurely()
    {
        // i don't know the right way to handle these, for now will just log some
        while ( RECENT_URL_LISTCOUNT <= gStats.recent_unhandled_errors.length )
        {
            gStats.recent_unhandled_errors.pop();
        }
        gStats.recent_unhandled_errors.unshift(connection.url);
        gStats.unhandled_errors++;
        if ( response !== null )
        {
            response.end();
        }
        if ( proxy !== null )
        {
            log(0,"3 PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
            log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
            log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
            log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
            log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
            log(0,"PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END PROXY END");
            proxy.end();
        }
        connection_terminated();
    }

    function launch_proxy() // will be called after upload_firstbyte latency
    {
        proxy = http.request(options, function(res) {
            log(1,'STATUS: ' + res.statusCode);
            log(1,'HEADERS: ' + JSON.stringify(res.headers));

            //res.on('data', function (chunk) {
            //    log(1,'BODY: len = ' + chunk.length);
            //});

        });
        intercept_upload_storeHeader();
        assert.ok(connection.upload_header_length === null,'expect the header to be created later');

        proxy.on('socket', function(socket) {
            // until the proxy socket is ready, I'm not ready to do much of anything
            upload_socket = socket;
            new_upload_stuff_is_ready();
        });

        proxy.on('error', function(e) {
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'!!!!!!!!!!!!!!!!!!!!!!!!!!!! PROXY ERROR !!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            log(0,'problem with request: ' + e.message);
            close_prematurely();
        });

        proxy.on('response', function (proxy_response) {
            var dheaders, dheader, dh, download_has_begun = false;

            function download_next_chunk() // called on timeout when it's ok to send more
            {
                var chunk, send_length;
                state.download_timeout = null;

                if ( state.download_chunks.length === 0 )
                {
                    if ( state.download_end_received )
                    {
                        if ( connection.drop_this_response )
                        {
                            request.connection.destroy(); // destroy the underlying socket so no data goes out
                        }
                        if ( response !== null ) // ???
                        {
                            response.end();
                        }
                        response = null;
                        maybe_all_done();
                    }
                }
                else
                {
                    chunk =  state.download_chunks.shift();
                    if ( discard_all_further_download_data || connection.drop_this_response )
                    {
                        state.download_timeout = setTimeout(download_next_chunk,0);
                    }
                    else
                    {
                        if ( connection.partial_this_response !== false )
                        {
                            if ( connection.partial_this_response <= (connection.download_sent + chunk.length) )
                            {
                                chunk = chunk.slice(0,connection.partial_this_response-connection.download_sent);
                                discard_all_further_download_data = true;
                            }
                        }
                        send_length = chunk.length;
                        response.write(chunk);

                        connection.download_sent += send_length;
                        connection.download_sending -= send_length;
                        state.download_timeout = setTimeout(download_next_chunk,calculate_millisecond(send_length,connection.download_mbps));
                    }
                }
            }
            function new_download_stuff_is_ready() // called when new stuff is ready to download in case a timeout is not ready to download soon
            {
                if ( (state.download_timeout === null) && download_has_begun )
                {
                    state.download_timeout = setTimeout(download_next_chunk,0);
                }
            }

            log(1,"### response");
            proxy_response.on('data', function(chunk) { // chunk is a buffer of data we just received
                // append chunk to state.download_chunks in max download_bytes_per_10ms byte sizes
                var total_dest_len, total_source_len, subchunk_len;
                total_source_len = chunk.length;
                if ( 0 < total_source_len )
                {
                    new_download_stuff_is_ready();
                    total_dest_len = 0;
                    while ( total_dest_len < total_source_len )
                    {
                        subchunk_len = Math.min(total_source_len-total_dest_len,download_bytes_per_10ms);
                        state.download_chunks.push(chunk.slice(total_dest_len,total_dest_len+subchunk_len));
                        connection.download_sending += subchunk_len;
                        total_dest_len += subchunk_len;
                    }
                }
            });
            proxy_response.addListener('end', function() {
                log(1,'END on proxy_response');
                new_download_stuff_is_ready();
                state.download_end_received = true;
            });

            proxy_response.addListener('close', function() {
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                log(1,'PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE PROXY RESPONSE CLOSE');
                new_download_stuff_is_ready();
                state.download_end_received = true;
            });

            // determine the download_content_length (if it's there in the headers)
            dheaders = Object.keys(proxy_response.headers);
            for ( dh = dheaders.length; dh--; )
            {
                dheader = dheaders[dh];
                if ( dheader.toLowerCase() === 'content-length' )
                {
                    try {
                        connection.download_content_length = parseInt(proxy_response.headers[dheader],10);
                    } catch(e) {
                    }
                }
            }

            function begin_downloading()
            {
                download_has_begun = true;

                if ( connection.drop_this_response )
                {
                    state.download_timeout = setTimeout(download_next_chunk,0);
                }
                else
                {
                    if ( connection.partial_this_response !== false )
                    {
                        // expect to only send part of the response to the client
                        if ( (connection.download_content_length === 0) || random_chance(10) )
                        {
                            // if there said to be no content, or randomly 10% of the time, return partial data in the header
                            partial_download_header = true;
                            discard_all_further_download_data = true;
                        }
                        else
                        {
                            // figure out where in the body to do a partial send
                            if ( connection.download_content_length !== null )
                            {
                                // set partial_this_response to where the download should be
                                connection.partial_this_response = Math.floor(Math.random() * connection.download_content_length);
                            }
                            else
                            {
                                // we don't know how long the content length is supposed to be, so pick a small number
                                connection.partial_this_response = 13;
                            }
                        }
                    }

                    //???assert.ok(connection.download_header_length === null,'expect the header to not be created yet');
                    response.writeHead(proxy_response.statusCode, proxy_response.headers);
                    assert.ok(connection.download_header_length !== null,'expect the header to be created now');

                    if ( partial_download_header !== false )
                    {
                        // data was cutoff somewhere in the header
                        connection.download_sent = connection.partial_this_response = partial_download_header;
                    }
                    else
                    {
                        connection.download_sent = connection.download_header_length;
                        if ( connection.partial_this_response !== false )
                        {
                            connection.partial_this_response += connection.download_header_length;
                        }
                    }
                }
                state.download_timeout = setTimeout(download_next_chunk,calculate_millisecond(connection.download_sent,connection.download_mbps));
            }
            setTimeout(begin_downloading,(connection.drop_this_response===0) ? 0 : connection.download_firstbyte);
        });
    }

    request.addListener('data', function(chunk) { // chunk is a buffer of data we just received
        // append chunk to state.upload_chunks in max upload_bytes_per_10ms byte sizes
        log(1,"### chunk length = " + chunk.length);
        var total_dest_len, total_source_len, subchunk_len;
        total_source_len = chunk.length;
        if ( 0 < total_source_len )
        {
            new_upload_stuff_is_ready();
            total_dest_len = 0;
            while ( total_dest_len < total_source_len )
            {
                if ( (connection.upload_sent === 0) && (connection.upload_sending === 0) )
                {
                    // the first byte is a little special because quirks in nodejs mean that the header isn't sent until the first byte is
                    subchunk_len = 1;
                }
                else
                {
                    subchunk_len = Math.min(total_source_len-total_dest_len,download_bytes_per_10ms);
                }
                subchunk_len = Math.min(total_source_len-total_dest_len,upload_bytes_per_10ms);
                state.upload_chunks.push(chunk.slice(total_dest_len,total_dest_len+subchunk_len));
                connection.upload_sending += subchunk_len;
                total_dest_len += subchunk_len;
            }
            log(1,"^^^^^^^^^^^^^^^^^ # chunks =  " + state.upload_chunks.length);
        }
    });
    request.addListener('end', function() {
        log(1,"### request end");
        state.upload_end_received = true;
        new_upload_stuff_is_ready();
    });
    request.addListener('close', function() {
        log(1,"### request close state.upload_end_received = " + state.upload_end_received);
        close_prematurely();
    });

    setTimeout(launch_proxy,connection.upload_firstbyte);
}

function update_display_forever()
{
    if ( gGatewayServer !== null )
    {
        log(0,'');
        log(0,new Date());
        log(0,gStats);
        log(0,"len gAbortActions = " + gAbortActions.length);
        log(0,'');
    }
    setTimeout(update_display_forever,1000);
}

function launch_gateway_server()
{
    gGatewayServer = http.createServer(gateway_request_handler);
    gGatewayServer.addListener('close', function() {
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        log(0,'############################## SERVER IS CLOSED #####################################');
        gGatewayServer = null;
    });
    gGatewayServer.listen(GATEWAY_PORT);
    log(0,"Gateway server running at http://127.0.0.1:" + GATEWAY_PORT + "/ redirecting to http://" + gCFG.host.value + ":" + gCFG.port.value + "/");
}

function coma_inducer_forever()
{
    gComaTimeout = null;

    function come_out_of_the_coma()
    {
        gEndComaTimeout = null;
        launch_gateway_server();
        gComaTimeout = setTimeout(coma_inducer_forever,gCFG.coma_frequency.value * 1000);
    }

    function wait_for_server_to_close()
    {
        if ( gGatewayServer === null )
        {
            log(0,'server is in a coma');
            gEndComaTimeout = setTimeout(come_out_of_the_coma,gCFG.coma_length.value * 1000);
        }
        else
        {
            process.stdout.write('.');
            while ( gAbortActions.length )
            {
                gAbortActions[0]();
            }
            setTimeout(wait_for_server_to_close,1);
        }
    }

    if ( gCFG.coma_frequency.value === 0 )
    {
        // don't want any comas - check again soon
        setTimeout(coma_inducer_forever,1000);
    }
    else
    {
        // put the server into a coma, like the user just entered a faraday cage,
        process.stdout.write('Putting server into a coma for ' + gCFG.coma_length.value + ' seconds (aborting ' + gAbortActions + 'connections)...');
        gGatewayServer.close();
        setTimeout(wait_for_server_to_close,1);
    }
}

function initialize() // will read the preference file for gCFG, then will launch_server()
{
    function step5_update_display()
    {
        log(0,'');
        setTimeout(update_display_forever,3000);
    }

    function step4_launch_coma_inducer()
    {
        gComaTimeout = setTimeout(coma_inducer_forever,gCFG.coma_frequency.value * 1000);
        step5_update_display();
    }

    function step3_launch_gateway_server()
    {
        launch_gateway_server();
        step4_launch_coma_inducer();
    }

    function step2_launch_admin_server()
    {
        var server = http.createServer(admin_request_handler);
        server.listen(ADMIN_PORT);
        log(0,"Admin server running at http://127.0.0.1:" + ADMIN_PORT + "/");
        step3_launch_gateway_server();
    }

    function step1_read_settings() // read settings from file, or if file doesn't exist just stick with defaults
    {
        function next_step()
        {
            step2_launch_admin_server();
        }

        log(0,"reading settings from file: " + PREFERENCES_FILESPEC);
        path.exists(PREFERENCES_FILESPEC, function (exists) {
            if (exists) {
                var prefsRead = fs.readFile(PREFERENCES_FILESPEC, function(err, data) {
                    fs.stat(PREFERENCES_FILESPEC, function (stat_error, stat, prefs) {
                        var newCFG, prop;
                        if (stat_error) {
                            log(0,"ERROR: " + PREFERENCES_FILESPEC + ", " + stat_error + "so use defaults");
                        } else {
                            if (stat.size > 0) {
                                log(1,'file has size ' + stat.size);
                                try {
                                    newCFG = JSON.parse(data);
                                    for ( prop in gCFG )
                                    {
                                        if ( gCFG.hasOwnProperty(prop) )
                                        {
                                            if ( newCFG.hasOwnProperty(prop) )
                                            {
                                                gCFG[prop].value = newCFG[prop];
                                            }
                                        }
                                    }
                                } catch(e) {
                                    log(0,"ERROR!!!!: " + e + "read prefs, so use defaults");
                                }
                            } else {
                                log(0,"prefs file does not exist, so use defaults");
                            }
                        }
                        next_step();
                    });
                });
            } else {
                log(0,"prefs file does not exist, so use defaults");
                next_step();
            }
        });
    }

    step1_read_settings();
}

function main()
{
    var args;

    log(0,'Running node version ' + process.version);
    log(0,'Running CrappyNet version ' + VERSION);
    log(0,'Learn all about CrappyNet at http://www.problemssolvingproblems.com/home/crappynet');
    log(0,'');

    try {
        args = process.argv.splice(2);
        if (args.length !== 3) { throw 'need args'; }
        ADMIN_PORT = parseInt(args[0],10);
        GATEWAY_PORT = parseInt(args[1],10);
        //PREFERENCES_FILESPEC = path.normalize(__dirname + '/' + args[2]);
        PREFERENCES_FILESPEC = path.normalize(args[2]);
    } catch(e) {
        log(0,"ERROR! Invalid paraemeters\n");
        log(0,"CrappyNet - Simulate a crappy network. Learn more at http://www.problemssolvingproblems.com/home/crappynet");
        log(0,"USAGE: node crappynet <admin-port> <gateway-port> <settings-filespec>");
        log(0,"EXAMPLE: node crappynet 9090 8080 crappynet_settings.json\n");
        process.exit(1);
    }
    // what else should happen, something to monitor when to stop?
    initialize();
}
main();
